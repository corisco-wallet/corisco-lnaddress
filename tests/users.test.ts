import { describe, expect, it } from "vitest";
import { verifyRegistrationSignature } from "../src/auth";
import { isValidUsername } from "../src/usernames";
import { DOMAIN, buildTestApp, newKeypair, register, sign } from "./helpers";

describe("POST /users", () => {
  it("creates a username for a new pubkey and returns the same one afterwards", async () => {
    const { app, users } = buildTestApp();
    const { pubkey, secretKey } = newKeypair();
    const first = (await (await register(app, pubkey, secretKey)).json()) as { username: string; address: string };
    const second = (await (await register(app, pubkey, secretKey)).json()) as { username: string };
    expect(first.address).toBe(`${first.username}@${DOMAIN}`);
    expect(second.username).toBe(first.username);
    expect((await users.getByUsername(first.username))?.identityPubkey).toBe(pubkey);
    expect((await users.getByPubkey(pubkey))?.username).toBe(first.username);
  });

  it("accepts compact signatures too", async () => {
    const { app } = buildTestApp();
    const { pubkey, secretKey } = newKeypair();
    const { nonce } = (await (await app.request("/challenge")).json()) as { nonce: string };
    const res = await app.request("/users", {
      method: "POST",
      body: JSON.stringify({ identityPubkey: pubkey, nonce, signature: sign(secretKey, nonce, "compact") }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a signature from a different key", async () => {
    const { app } = buildTestApp();
    const owner = newKeypair();
    const attacker = newKeypair();
    const { nonce } = (await (await app.request("/challenge")).json()) as { nonce: string };
    const res = await app.request("/users", {
      method: "POST",
      body: JSON.stringify({ identityPubkey: owner.pubkey, nonce, signature: sign(attacker.secretKey, nonce) }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects replay of a used nonce", async () => {
    const { app } = buildTestApp();
    const { pubkey, secretKey } = newKeypair();
    const { nonce } = (await (await app.request("/challenge")).json()) as { nonce: string };
    const body = JSON.stringify({ identityPubkey: pubkey, nonce, signature: sign(secretKey, nonce) });
    expect((await app.request("/users", { method: "POST", body })).status).toBe(200);
    expect((await app.request("/users", { method: "POST", body })).status).toBe(401);
  });

  it("rejects a nonce the server never issued and a malformed pubkey", async () => {
    const { app } = buildTestApp();
    const { pubkey, secretKey } = newKeypair();
    const forged = "00".repeat(16);
    const unknown = await app.request("/users", {
      method: "POST",
      body: JSON.stringify({ identityPubkey: pubkey, nonce: forged, signature: sign(secretKey, forged) }),
    });
    expect(unknown.status).toBe(401);
    const bad = await app.request("/users", {
      method: "POST",
      body: JSON.stringify({ identityPubkey: "02" + "00".repeat(32), nonce: forged, signature: "00" }),
    });
    expect(bad.status).toBe(400);
  });

  it("rejects a signature bound to another domain", () => {
    const { pubkey, secretKey } = newKeypair();
    expect(verifyRegistrationSignature(pubkey, "n", DOMAIN, sign(secretKey, "n"))).toBe(true);
    expect(verifyRegistrationSignature(pubkey, "n", "other.test", sign(secretKey, "n"))).toBe(false);
  });
});

describe("isValidUsername", () => {
  it("applies charset, length and reserved-name rules", () => {
    expect(isValidUsername("alice")).toBe(true);
    expect(isValidUsername("al")).toBe(false);
    expect(isValidUsername("Alice")).toBe(false);
    expect(isValidUsername("admin")).toBe(false);
    expect(isValidUsername("-alice")).toBe(false);
    expect(isValidUsername("a".repeat(33))).toBe(false);
  });
});
