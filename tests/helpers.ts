import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createApp } from "../src/app";
import { registrationDigest } from "../src/auth";
import { ChallengeStore } from "../src/challenge";
import type { Config } from "../src/config";
import type { InvoiceRequest } from "../src/invoices";
import { MemoryInvoiceStore } from "./memory-invoice-store";
import { MemoryUserStore } from "./memory-store";

export const DOMAIN = "example.test";

export const config: Config = {
  port: 0,
  network: "REGTEST",
  domain: DOMAIN,
  publicBaseUrl: "https://example.test",
  database: { host: "unused", port: 3306, user: "unused", password: "unused", name: "unused" },
  dataKey: Buffer.alloc(32),
  serverMnemonic: "unused",
  maxSendableSats: 100_000,
  invoiceRetentionDays: 7,
};

export const TEST_PAYMENT_HASH = "7e".repeat(32);
export const TEST_NOW = 1_700_000_000_000;

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
  const users = new MemoryUserStore();
  const challenges = new ChallengeStore();
  const invoiceStore = new MemoryInvoiceStore(users);
  const app = createApp({
    config,
    users,
    challenges,
    invoiceStore,
    now: () => TEST_NOW,
    invoices: {
      async createInvoice(request) {
        created.push(request);
        return {
          pr: "lnbcrt-test-invoice",
          paymentHash: TEST_PAYMENT_HASH,
          receiveRequestId: "spark-request-1",
          expiresAt: TEST_NOW + request.expirySeconds * 1000,
        };
      },
    },
  });
  return { app, users, challenges, created, invoiceStore };
}

export async function register(app: ReturnType<typeof buildTestApp>["app"], pubkey: string, secretKey: Uint8Array) {
  const { nonce } = (await (await app.request("/challenge")).json()) as { nonce: string };
  return app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityPubkey: pubkey, nonce, signature: sign(secretKey, nonce) }),
  });
}
