import { describe, expect, it } from "vitest";
import { buildMetadata, descriptionHash } from "../src/lnurl";
import { DOMAIN, buildTestApp, newKeypair, register } from "./helpers";

async function registered() {
  const ctx = buildTestApp();
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
    expect(await res.json()).toEqual({ pr: "lnbcrt-test-invoice", routes: [] });
    expect(created).toEqual([
      {
        amountSats: 5000,
        descriptionHash: descriptionHash(buildMetadata(username, DOMAIN)),
        receiverIdentityPubkey: pubkey,
        expirySeconds: 3600,
      },
    ]);
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
