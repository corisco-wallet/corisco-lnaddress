import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createApp } from "../src/app";
import { registrationDigest } from "../src/auth";
import { ChallengeStore } from "../src/challenge";
import type { Config } from "../src/config";
import { UserStore } from "../src/db";
import type { InvoiceRequest } from "../src/invoices";

export const DOMAIN = "example.test";

export const config: Config = {
  port: 0,
  network: "REGTEST",
  domain: DOMAIN,
  publicBaseUrl: "https://example.test",
  dbPath: ":memory:",
  serverMnemonic: "unused",
  maxSendableSats: 100_000,
};

export function newKeypair() {
  const { secretKey, publicKey } = secp256k1.keygen();
  return { secretKey, pubkey: bytesToHex(publicKey) };
}

export function sign(secretKey: Uint8Array, nonce: string, format: "compact" | "der" = "der"): string {
  const sig = secp256k1.sign(registrationDigest(nonce, DOMAIN), secretKey, { prehash: false, format });
  return bytesToHex(sig);
}

export function buildTestApp() {
  const created: InvoiceRequest[] = [];
  const users = new UserStore(":memory:");
  const challenges = new ChallengeStore();
  const app = createApp({
    config,
    users,
    challenges,
    invoices: {
      async createInvoice(request) {
        created.push(request);
        return "lnbcrt-test-invoice";
      },
    },
  });
  return { app, users, challenges, created };
}

export async function register(app: ReturnType<typeof buildTestApp>["app"], pubkey: string, secretKey: Uint8Array) {
  const { nonce } = (await (await app.request("/challenge")).json()) as { nonce: string };
  return app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityPubkey: pubkey, nonce, signature: sign(secretKey, nonce) }),
  });
}
