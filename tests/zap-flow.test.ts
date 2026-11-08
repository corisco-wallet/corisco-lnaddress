import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "../src/nostr";
import { SettlementWatcher } from "../src/settlement";
import { ZapPublisher } from "../src/zap-publisher";
import { ZapSigner } from "../src/zaps";
import { startFakeRelay } from "./fake-relay";
import { TEST_NOW, buildTestApp, newKeypair, register } from "./helpers";
import { RECIPIENT, randomKeys, zapRequest } from "./nostr-fixtures";

const PREIMAGE = "5a".repeat(32);
const PAYMENT_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const relays: Awaited<ReturnType<typeof startFakeRelay>>[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe("zap end to end", () => {
  it("publishes a receipt clients can verify once the zap invoice is paid", async () => {
    const relay = await startFakeRelay({ requireAuth: true });
    relays.push(relay);
    const zaps = { signer: new ZapSigner(new Uint8Array(32).fill(5)), policy: { allowPrivate: true } };
    const { app, invoiceStore } = buildTestApp({
      zaps,
      invoices: {
        createInvoice: async () => ({ pr: "lnbcrt-zap", paymentHash: PAYMENT_HASH, receiveRequestId: "req", expiresAt: TEST_NOW + 3_600_000 }),
      },
    });
    const { pubkey, secretKey } = newKeypair();
    const { username } = (await (await register(app, pubkey, secretKey)).json()) as { username: string };

    const lnurl = (await (await app.request(`/.well-known/lnurlp/${username}`)).json()) as { nostrPubkey: string };
    const request = zapRequest(randomKeys(), { tags: [["relays", relay.url], ["amount", "21000"], ["p", RECIPIENT]] });
    await app.request(`/lnurl/callback/${username}?amount=21000&nostr=${encodeURIComponent(request)}`);

    const settlement = new SettlementWatcher({
      store: invoiceStore,
      retentionDays: 7,
      now: () => TEST_NOW + 60_000,
      source: { getReceiveStatus: async () => ({ settled: true, preimage: PREIMAGE }) },
    });
    // Long poll interval, so only the settlement kick can publish in time.
    const publisher = new ZapPublisher({ store: invoiceStore, ...zaps });
    settlement.onSettled(() => publisher.kick());
    publisher.start({ everyMs: 60_000 });
    await settlement.poll();
    await expect.poll(() => relay.received.length, { timeout: 2_000 }).toBe(1);
    await publisher.stop();

    // What a NIP-57 client checks before counting the zap.
    const receipt: NostrEvent = relay.received[0];
    const tag = (name: string) => receipt.tags.find((t) => t[0] === name)?.[1];
    expect(receipt.kind).toBe(9735);
    expect(receipt.pubkey).toBe(lnurl.nostrPubkey);
    expect(tag("description")).toBe(request);
    expect(tag("bolt11")).toBe("lnbcrt-zap");
    expect(tag("preimage")).toBe(PREIMAGE);
    expect(receipt.created_at).toBe(Math.floor((TEST_NOW + 60_000) / 1000));
    expect(createHash("sha256").update(tag("description")!).digest("hex")).toBe(
      createHash("sha256").update(request).digest("hex"),
    );
    expect(invoiceStore.zapOf(PAYMENT_HASH)?.state).toBe("published");
  });
});
