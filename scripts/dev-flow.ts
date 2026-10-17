import { createHash } from "node:crypto";
import { DefaultSparkSigner, SparkWallet } from "@buildonspark/spark-sdk";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "light-bolt11-decoder";
import { registrationDigest } from "../src/auth";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const domain = process.env.LNADDRESS_DOMAIN;
const payerMnemonic = process.env.PAYER_MNEMONIC;
const amountSats = Number(process.env.AMOUNT_SATS ?? 1000);

if (!domain) throw new Error("LNADDRESS_DOMAIN must match the server's value");

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
  return (await res.json()) as T;
}

const signer = new DefaultSparkSigner();
const mnemonic = await signer.generateMnemonic();
const { wallet: user } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, signer, options: { network: "REGTEST" } });
const identityPubkey = await user.getIdentityPublicKey();
console.log("user identity pubkey:", identityPubkey);

const { nonce } = await getJson<{ nonce: string }>("/challenge");
const signature = bytesToHex(await signer.signMessageWithIdentityKey(registrationDigest(nonce, domain)));
const registered = await getJson<{ username: string; address: string }>("/users", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identityPubkey, nonce, signature }),
});
console.log("registered:", registered);

const payRequest = await getJson<{ callback: string; minSendable: number; maxSendable: number; metadata: string }>(
  `/.well-known/lnurlp/${registered.username}`,
);
console.log("payRequest:", payRequest);

const { pr } = await getJson<{ pr: string }>(new URL(payRequest.callback).pathname + `?amount=${amountSats * 1000}`);
const hTag = (decode(pr).sections as { name: string; value?: unknown }[]).find((s) => s.name === "description_hash")?.value;
const expected = createHash("sha256").update(payRequest.metadata).digest("hex");
console.log("invoice h tag matches sha256(metadata):", hTag === expected);

if (!payerMnemonic) {
  console.log("invoice:", pr);
  console.log("set PAYER_MNEMONIC to pay it and check the user's balance");
  process.exit(0);
}

const { wallet: payer } = await SparkWallet.initialize({ mnemonicOrSeed: payerMnemonic, options: { network: "REGTEST" } });
const payment = await payer.payLightningInvoice({ invoice: pr, maxFeeSats: 50 });
console.log("payment status:", (payment as { status?: string }).status);

const claim = user as unknown as { claimTransfers(): Promise<string[]> };
let available = 0n;
for (let attempt = 0; attempt < 15 && available < BigInt(amountSats); attempt++) {
  await claim.claimTransfers();
  available = (await user.getBalance()).satsBalance.available;
  if (available < BigInt(amountSats)) await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log(`user available sats: ${available} (expected ${amountSats})`);
process.exit(0);
