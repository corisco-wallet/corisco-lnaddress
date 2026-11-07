import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Invoice } from "../src/invoice-store";
import { isSettledStatus, type ReceiveStatus } from "../src/invoices";
import { type CheckSchedule, SettlementWatcher, backstopCheckDelay, nextCheckDelay, preimageMatches } from "../src/settlement";
import { newInvoice } from "./invoice-store-contract";
import { MemoryInvoiceStore } from "./memory-invoice-store";
import { MemoryUserStore } from "./memory-store";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PREIMAGE = "5a".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");

async function setup(schedule?: CheckSchedule) {
  const users = new MemoryUserStore();
  await users.getOrCreate("02" + "ab".repeat(32), () => "payee-name-001");
  const store = new MemoryInvoiceStore(users);
  let clock = 0;
  const statuses = new Map<string, ReceiveStatus | null | Error>();
  const lookups: string[] = [];
  const log = { error: vi.fn(), warn: vi.fn() };
  const watcher = new SettlementWatcher({
    store,
    retentionDays: 7,
    schedule,
    now: () => clock,
    log,
    source: {
      async getReceiveStatus(id) {
        lookups.push(id);
        const status = statuses.get(id) ?? { settled: false, preimage: null };
        if (status instanceof Error) throw status;
        return status;
      },
    },
  });
  const settled: Invoice[] = [];
  watcher.onSettled((invoice) => void settled.push(invoice));
  await store.create(newInvoice({ paymentHash: HASH, receiveRequestId: "req", createdAt: 0, expiresAt: 60 * MINUTE }), 3_000);
  return {
    store,
    watcher,
    statuses,
    lookups,
    log,
    settled,
    at: (ms: number) => {
      clock = ms;
    },
  };
}

describe("SettlementWatcher", () => {
  it("only checks invoices once they are due", async () => {
    const { watcher, lookups, at } = await setup();
    at(2_999);
    await watcher.poll();
    expect(lookups).toEqual([]);
    at(3_000);
    await watcher.poll();
    expect(lookups).toEqual(["req"]);
    await watcher.poll();
    expect(lookups).toEqual(["req"]);
  });

  it("marks a paid invoice settled, stores the preimage and notifies once", async () => {
    const { watcher, store, statuses, settled, at } = await setup();
    statuses.set("req", { settled: true, preimage: PREIMAGE });
    at(10_000);
    await watcher.poll();
    await watcher.poll();
    expect(await store.get(HASH)).toMatchObject({ status: "settled", preimage: PREIMAGE, settledAt: 10_000 });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ paymentHash: HASH, status: "settled", preimage: PREIMAGE, settledAt: 10_000 });
  });

  it("does not settle when the preimage doesn't match the payment hash", async () => {
    const { watcher, store, statuses, settled, log, at } = await setup();
    statuses.set("req", { settled: true, preimage: "00".repeat(32) });
    at(10_000);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("pending");
    expect(settled).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("does not settle without a preimage", async () => {
    const { watcher, store, statuses, at } = await setup();
    statuses.set("req", { settled: true, preimage: null });
    at(10_000);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("pending");
  });

  it("backs off between checks as the invoice ages", async () => {
    const { watcher, store, at } = await setup();
    at(3_000);
    await watcher.poll();
    expect(await store.due(5_999, 10)).toHaveLength(0);
    expect(await store.due(6_000, 10)).toHaveLength(1);
    at(20 * MINUTE);
    await watcher.poll();
    expect(await store.due(21 * MINUTE - 1, 10)).toHaveLength(0);
    expect(await store.due(21 * MINUTE, 10)).toHaveLength(1);
  });

  it("keeps checking through the grace period, then expires the invoice", async () => {
    const { watcher, store, at } = await setup();
    at(62 * MINUTE);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("pending");
    at(64 * MINUTE);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("expired");
  });

  it("settles a payment that lands just after the expiry time", async () => {
    const { watcher, store, statuses, at } = await setup();
    statuses.set("req", { settled: true, preimage: PREIMAGE });
    at(61 * MINUTE);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("settled");
  });

  it("retries later when the lookup fails, and never expires an invoice it couldn't check", async () => {
    const { watcher, store, statuses, log, at } = await setup();
    statuses.set("req", new Error("spark unavailable"));
    at(90 * MINUTE);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("pending");
    expect(log.error).toHaveBeenCalled();
    expect(await store.due(90 * MINUTE + 29_999, 10)).toHaveLength(0);
    expect(await store.due(90 * MINUTE + 30_000, 10)).toHaveLength(1);
  });

  it("keeps going when a listener throws", async () => {
    const { watcher, store, statuses, log, at } = await setup();
    watcher.onSettled(() => {
      throw new Error("listener broke");
    });
    statuses.set("req", { settled: true, preimage: PREIMAGE });
    at(10_000);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("settled");
    expect(log.error).toHaveBeenCalledWith("invoice settled listener failed:", expect.any(Error));
  });

  it("checks no more invoices at once than the concurrency limit", async () => {
    const users = new MemoryUserStore();
    await users.getOrCreate("02" + "ab".repeat(32), () => "payee-name-001");
    const store = new MemoryInvoiceStore(users);
    for (let i = 0; i < 10; i++) {
      await store.create(newInvoice({ paymentHash: i.toString(16).padStart(64, "0"), receiveRequestId: `r${i}` }), 0);
    }
    let active = 0;
    let peak = 0;
    const watcher = new SettlementWatcher({
      store,
      retentionDays: 7,
      now: () => 1_000,
      concurrency: 3,
      source: {
        async getReceiveStatus() {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
          return { settled: false, preimage: null };
        },
      },
    });
    await watcher.poll();
    expect(peak).toBe(3);
    expect(await store.due(1_000, 20)).toHaveLength(0);
  });

  it("purges expired rows shortly after expiry and settled rows after the retention period", async () => {
    const { watcher, store, statuses, at } = await setup();
    statuses.set("req", { settled: true, preimage: PREIMAGE });
    at(10_000);
    await watcher.poll();
    at(10_000 + 7 * DAY);
    expect(await watcher.purge()).toBe(0);
    at(10_001 + 7 * DAY);
    expect(await watcher.purge()).toBe(1);
    expect(await store.get(HASH)).toBeUndefined();

    await store.create(newInvoice({ paymentHash: "ee".repeat(32), receiveRequestId: "unpaid", expiresAt: 100 }), 0);
    await store.markExpired("ee".repeat(32));
    at(100 + 10 * MINUTE);
    expect(await watcher.purge()).toBe(0);
    at(101 + 10 * MINUTE);
    expect(await watcher.purge()).toBe(1);
  });

  it("follows a custom schedule", async () => {
    const { watcher, store, at } = await setup(backstopCheckDelay);
    expect(watcher.firstCheckDelayMs).toBe(30_000);
    at(3_000);
    await watcher.poll();
    expect(await store.due(33_000 - 1, 10)).toHaveLength(0);
    expect(await store.due(33_000, 10)).toHaveLength(1);
  });

  it("checkSoon makes a pending invoice due now, and the check still verifies with Spark", async () => {
    const { watcher, store, statuses, lookups, settled, at } = await setup(backstopCheckDelay);
    at(1_000);
    await watcher.poll();
    expect(lookups).toEqual([]);

    // A webhook that arrives before Spark reports the payment settles nothing.
    expect(await watcher.checkSoon("req")).toBe(true);
    await watcher.poll();
    expect(lookups).toEqual(["req"]);
    expect((await store.get(HASH))?.status).toBe("pending");

    statuses.set("req", { settled: true, preimage: PREIMAGE });
    expect(await watcher.checkSoon("req")).toBe(true);
    await watcher.poll();
    expect((await store.get(HASH))?.status).toBe("settled");
    expect(settled).toHaveLength(1);

    expect(await watcher.checkSoon("req")).toBe(false);
    expect(await watcher.checkSoon("unknown")).toBe(false);
  });

  it("stops cleanly while running on timers", async () => {
    const { watcher, lookups, at } = await setup();
    at(3_000);
    watcher.start({ pollEveryMs: 5, purgeEveryMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await watcher.stop();
    const seen = lookups.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toBeGreaterThan(0);
    expect(lookups).toHaveLength(seen);
  });
});

describe("helpers", () => {
  it("checks a preimage against its payment hash", () => {
    expect(preimageMatches(PREIMAGE, HASH)).toBe(true);
    expect(preimageMatches("00".repeat(32), HASH)).toBe(false);
    expect(preimageMatches("zz", HASH)).toBe(false);
  });

  it("backs off with age", () => {
    expect([0, 3 * MINUTE, 30 * MINUTE].map(nextCheckDelay)).toEqual([3_000, 15_000, 60_000]);
    expect([0, 3 * MINUTE, 30 * MINUTE].map(backstopCheckDelay)).toEqual([30_000, 120_000, 120_000]);
  });

  it("only treats received payments as settled", () => {
    expect(isSettledStatus("TRANSFER_COMPLETED")).toBe(true);
    expect(isSettledStatus("LIGHTNING_PAYMENT_RECEIVED")).toBe(true);
    expect(isSettledStatus("INVOICE_CREATED")).toBe(false);
    expect(isSettledStatus("FUTURE_VALUE")).toBe(false);
  });
});
