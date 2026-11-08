import { describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "../src/nostr";
import { type Publish, ZapPublisher, retryDelay } from "../src/zap-publisher";
import { ZapSigner } from "../src/zaps";
import { newInvoice } from "./invoice-store-contract";
import { MemoryInvoiceStore } from "./memory-invoice-store";
import { MemoryUserStore } from "./memory-store";
import { randomKeys, zapRequest } from "./nostr-fixtures";

const PUBKEY = "02" + "ab".repeat(32);
const HASH = "a1".repeat(32);
const PREIMAGE = "5a".repeat(32);
const DAY = 24 * 60 * 60 * 1000;

async function setup(accepted: () => number | Promise<number> = () => 1) {
  const users = new MemoryUserStore();
  await users.getOrCreate(PUBKEY, () => "payee-name-001");
  const store = new MemoryInvoiceStore(users);
  const signer = new ZapSigner(new Uint8Array(32).fill(9));
  const request = zapRequest(randomKeys());
  await store.create(newInvoice({ paymentHash: HASH, zapRequest: request }), 0);
  let clock = 0;
  const sent: { relays: string[]; event: NostrEvent }[] = [];
  const publish: Publish = async (relays, event) => {
    sent.push({ relays, event });
    return accepted();
  };
  const log = { error: vi.fn(), warn: vi.fn() };
  const publisher = new ZapPublisher({ store, signer, policy: { allowPrivate: false }, publish, now: () => clock, log });
  return { store, signer, request, publisher, sent, log, at: (ms: number) => (clock = ms) };
}

describe("ZapPublisher", () => {
  it("publishes nothing until the invoice settles", async () => {
    const { publisher, sent } = await setup();
    await publisher.publishDue();
    expect(sent).toEqual([]);
  });

  it("publishes the receipt to the zap request's relays, signed with the receiver's key, once", async () => {
    const { store, signer, request, publisher, sent } = await setup();
    // Settling is enough to queue the receipt: no listener has to run, so a crash after settling loses nothing.
    await store.markSettled(HASH, PREIMAGE, 10_000);
    await publisher.publishDue();
    await publisher.publishDue();

    expect(sent).toHaveLength(1);
    expect(sent[0].relays).toEqual(["wss://relay.example.com/", "wss://nos.example.org/"]);
    expect(sent[0].event).toMatchObject({ kind: 9735, pubkey: signer.keysFor(PUBKEY).pubkey, created_at: 10 });
    expect(sent[0].event.tags).toContainEqual(["description", request]);
    expect(store.zapOf(HASH)).toMatchObject({ state: "published", receipt: JSON.stringify(sent[0].event) });
  });

  it("retries with backoff when no relay accepts it", async () => {
    const { store, publisher, sent, at } = await setup(() => 0);
    await store.markSettled(HASH, PREIMAGE, 0);
    at(1_000);
    await publisher.publishDue();
    expect(store.zapOf(HASH)).toMatchObject({ state: "pending", attempts: 1, nextAttemptAt: 31_000 });
    at(30_999);
    await publisher.publishDue();
    expect(sent).toHaveLength(1);
    at(31_000);
    await publisher.publishDue();
    expect(store.zapOf(HASH)).toMatchObject({ attempts: 2, nextAttemptAt: 31_000 + 45_000 });
  });

  it("counts a throw as a failed attempt so the receipt backs off", async () => {
    const { store, publisher, log } = await setup(() => {
      throw new Error("boom");
    });
    await store.markSettled(HASH, PREIMAGE, 0);
    await publisher.publishDue();
    expect(log.error).toHaveBeenCalledWith("zap receipt failed:", expect.any(Error));
    expect(store.zapOf(HASH)).toMatchObject({ state: "pending", attempts: 1, nextAttemptAt: 30_000 });
  });

  it("retries when recording the published receipt fails", async () => {
    const { store, publisher } = await setup();
    await store.markSettled(HASH, PREIMAGE, 0);
    vi.spyOn(store, "zapReceiptPublished").mockRejectedValueOnce(new Error("db down"));
    await publisher.publishDue();
    expect(store.zapOf(HASH)).toMatchObject({ state: "pending", attempts: 1 });
  });

  it("backs off an unreadable row without holding up the others", async () => {
    const { store, publisher, sent, log } = await setup();
    await store.markSettled(HASH, PREIMAGE, 0);
    const bad = { paymentHash: "b2".repeat(32), settledAt: 0, attempts: 0, error: new Error("failed verification") };
    const failed = vi.spyOn(store, "zapReceiptFailed");
    const due = store.dueZapReceipts.bind(store);
    vi.spyOn(store, "dueZapReceipts").mockImplementationOnce(async (now, limit) => [bad, ...(await due(now, limit))]);
    await publisher.publishDue();
    expect(failed).toHaveBeenCalledWith(bad.paymentHash, 1, 30_000);
    expect(log.error).toHaveBeenCalledWith("zap receipt failed:", bad.error);
    expect(sent).toHaveLength(1);
    expect(store.zapOf(HASH)?.state).toBe("published");
  });

  it("logs when even recording the failure fails", async () => {
    const { store, publisher, log } = await setup(() => 0);
    await store.markSettled(HASH, PREIMAGE, 0);
    vi.spyOn(store, "zapReceiptFailed").mockRejectedValueOnce(new Error("db down"));
    await expect(publisher.publishDue()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("could not record a failed zap receipt:", expect.any(Error));
  });

  it("gives up two weeks after payment", async () => {
    const { store, publisher, log, at } = await setup(() => 0);
    await store.markSettled(HASH, PREIMAGE, 0);
    at(14 * DAY + 1);
    await publisher.publishDue();
    expect(store.zapOf(HASH)).toMatchObject({ state: "abandoned", nextAttemptAt: null });
    expect(log.warn).toHaveBeenCalled();
  });

  it("publishes right away when kicked, and stops cleanly", async () => {
    const { store, publisher, sent } = await setup();
    publisher.start({ everyMs: 60_000 });
    await store.markSettled(HASH, PREIMAGE, 0);
    publisher.kick();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await publisher.stop();
    expect(store.zapOf(HASH)?.state).toBe("published");
  });
});

describe("retryDelay", () => {
  it("grows from 30 s and caps at an hour", () => {
    expect([1, 2, 3].map(retryDelay)).toEqual([30_000, 45_000, 67_500]);
    expect(retryDelay(50)).toBe(3_600_000);
  });
});
