import { describe, expect, it } from "vitest";
import { buildMetadata, descriptionHash } from "../src/lnurl";
import { ZapSigner } from "../src/zaps";
import { DOMAIN, TEST_NOW, TEST_PAYMENT_HASH, buildTestApp, newKeypair, register } from "./helpers";
import { randomKeys, zapRequest } from "./nostr-fixtures";

async function registered(extra: Parameters<typeof buildTestApp>[0] = {}) {
  const ctx = buildTestApp(extra);
  const { pubkey, secretKey } = newKeypair();
  const { username } = (await (await register(ctx.app, pubkey, secretKey)).json()) as { username: string };
  return { ...ctx, pubkey, username };
}

describe("GET /.well-known/lnurlp/:username", () => {
  it("returns a payRequest", async () => {
    const { app, username } = await registered();
    const res = await app.request(`/.well-known/lnurlp/${username}`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      tag: "payRequest",
      callback: `https://example.test/lnurl/callback/${username}`,
      minSendable: 1000,
      maxSendable: 100_000_000,
      metadata: buildMetadata(username, DOMAIN),
    });
  });

  it("returns an LNURL error for unknown users", async () => {
    const { app } = buildTestApp();
    expect(await (await app.request("/.well-known/lnurlp/nobody")).json()).toEqual({ status: "ERROR", reason: "unknown user" });
  });
});

describe("GET /lnurl/callback/:username", () => {
  it("mints an invoice for the registered pubkey bound to the metadata hash", async () => {
    const { app, created, username, pubkey } = await registered();
    const res = await app.request(`/lnurl/callback/${username}?amount=5000000`);
    expect(await res.json()).toEqual({ pr: "lnbcrt-test-invoice", successAction: null, disposable: false, routes: [] });
    expect(created).toEqual([
      {
        amountSats: 5000,
        descriptionHash: descriptionHash(buildMetadata(username, DOMAIN)),
        receiverIdentityPubkey: pubkey,
        expirySeconds: 3600,
      },
    ]);
  });

  it("stores every invoice it hands out", async () => {
    const { app, invoiceStore, username } = await registered();
    await app.request(`/lnurl/callback/${username}?amount=5000000`);
    expect(await invoiceStore.get(TEST_PAYMENT_HASH)).toEqual({
      paymentHash: TEST_PAYMENT_HASH,
      receiveRequestId: "spark-request-1",
      amountMsat: 5_000_000,
      pr: "lnbcrt-test-invoice",
      status: "pending",
      preimage: null,
      createdAt: TEST_NOW,
      expiresAt: TEST_NOW + 3_600_000,
      settledAt: null,
    });
    expect(await invoiceStore.due(TEST_NOW + 2_999, 10)).toHaveLength(0);
    expect(await invoiceStore.due(TEST_NOW + 3_000, 10)).toHaveLength(1);
  });

  it("does not return an invoice it could not store", async () => {
    const { app, invoiceStore, username } = await registered();
    invoiceStore.create = async () => {
      throw new Error("database down");
    };
    const body = await (await app.request(`/lnurl/callback/${username}?amount=5000000`)).json();
    expect(body).toEqual({ status: "ERROR", reason: "could not create invoice" });
  });

  it.each([["missing", ""], ["fractional sats", "?amount=1500"], ["below min", "?amount=0"], ["above max", "?amount=100001000"], ["not a number", "?amount=abc"]])(
    "rejects %s amounts",
    async (_name, query) => {
      const { app, created, username } = await registered();
      const body = (await (await app.request(`/lnurl/callback/${username}${query}`)).json()) as { status: string };
      expect(body.status).toBe("ERROR");
      expect(created).toHaveLength(0);
    },
  );

  it("returns an LNURL error for unknown users", async () => {
    const { app } = buildTestApp();
    const body = (await (await app.request("/lnurl/callback/nobody?amount=1000")).json()) as { status: string };
    expect(body.status).toBe("ERROR");
  });
});

describe("nostr zaps", () => {
  const zaps = { signer: new ZapSigner(new Uint8Array(32).fill(3)), policy: { allowPrivate: false } };
  const sender = randomKeys();

  it("advertises zap support with the user's own receipt key", async () => {
    const { app, username, pubkey } = await registered({ zaps });
    const body = await (await app.request(`/.well-known/lnurlp/${username}`)).json();
    expect(body).toMatchObject({ tag: "payRequest", allowsNostr: true, nostrPubkey: zaps.signer.keysFor(pubkey).pubkey });
  });

  it("mints a zap invoice committed to the zap request and stores the request with it", async () => {
    const { app, created, invoiceStore, username } = await registered({ zaps });
    const request = zapRequest(sender, {}, 21_000);
    const res = await app.request(`/lnurl/callback/${username}?amount=21000&nostr=${encodeURIComponent(request)}`);
    expect(await res.json()).toMatchObject({ pr: "lnbcrt-test-invoice" });
    expect(created[0].descriptionHash).toBe(descriptionHash(request));
    expect(invoiceStore.zapOf(TEST_PAYMENT_HASH)).toMatchObject({ request, state: "pending" });
  });

  it("rejects an invalid zap request without minting an invoice", async () => {
    const { app, created, username } = await registered({ zaps });
    const request = zapRequest(sender, {}, 1_000);
    const body = await (await app.request(`/lnurl/callback/${username}?amount=21000&nostr=${encodeURIComponent(request)}`)).json();
    expect(body).toEqual({ status: "ERROR", reason: "invalid zap request: amount does not match" });
    expect(created).toHaveLength(0);
  });

  it("refuses zap requests when zaps are off, and doesn't advertise them", async () => {
    const { app, created, username } = await registered();
    const meta = (await (await app.request(`/.well-known/lnurlp/${username}`)).json()) as Record<string, unknown>;
    expect(meta.allowsNostr).toBeUndefined();
    const request = encodeURIComponent(zapRequest(sender));
    const body = await (await app.request(`/lnurl/callback/${username}?amount=21000&nostr=${request}`)).json();
    expect(body).toEqual({ status: "ERROR", reason: "nostr zaps are not supported" });
    expect(created).toHaveLength(0);
  });

  it("keeps plain payments working with zaps on", async () => {
    const { app, created, invoiceStore, username } = await registered({ zaps });
    await app.request(`/lnurl/callback/${username}?amount=21000`);
    expect(created[0].descriptionHash).toBe(descriptionHash(buildMetadata(username, DOMAIN)));
    expect(invoiceStore.zapOf(TEST_PAYMENT_HASH)).toBeNull();
  });
});
