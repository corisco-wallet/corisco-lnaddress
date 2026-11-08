import { createHash } from "node:crypto";
import { DefaultSparkSigner, SparkWallet } from "@buildonspark/spark-sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "light-bolt11-decoder";
import WebSocket from "ws";
import { registrationDigest } from "../src/auth";
import { type NostrEvent, type NostrKeys, keysFromSecret, parseSignedEvent, signEvent } from "../src/nostr";

// End-to-end NIP-57 check against a running server on regtest: zap a fresh address, pay it, and verify the receipt
// the way a Nostr client would.
const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const domain = process.env.LNADDRESS_DOMAIN;
const payerMnemonic = process.env.PAYER_MNEMONIC;
const relayUrl = process.env.RELAY_URL ?? "wss://nos.lol";
const amountSats = Number(process.env.AMOUNT_SATS ?? 21);
const receiptTimeoutMs = Number(process.env.RECEIPT_TIMEOUT_MS ?? 90_000);

if (!domain) throw new Error("LNADDRESS_DOMAIN must match the server's value");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `: ${detail}` : ""}`);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await (await fetch(url, init)).json()) as T;
}

const randomKeys = (): NostrKeys => keysFromSecret(schnorr.utils.randomSecretKey());

function invoiceSections(pr: string) {
  const sections = decode(pr).sections as { name: string; value?: unknown }[];
  return {
    descriptionHash: sections.find((s) => s.name === "description_hash")?.value as string | undefined,
    amountMsat: sections.find((s) => s.name === "amount")?.value as string | undefined,
  };
}

function buildZapRequest(sender: NostrKeys, recipient: string, amountMsat: number, extraTags: string[][] = []): string {
  const event = signEvent(
    {
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000),
      content: "corisco zap-flow test",
      tags: [["relays", relayUrl], ["amount", String(amountMsat)], ["p", recipient], ...extraTags],
    },
    sender,
  );
  return JSON.stringify(event);
}

/** Subscribes before paying, so a receipt published right after settlement isn't missed. */
function waitForReceipt(recipient: string, zapRequest: string): { receipt: Promise<NostrEvent>; close: () => void } {
  const socket = new WebSocket(relayUrl);
  const subId = "zap-flow-" + Math.random().toString(36).slice(2, 8);
  let close = () => {};
  const receipt = new Promise<NostrEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no receipt on ${relayUrl} within ${receiptTimeoutMs} ms`)), receiptTimeoutMs);
    close = () => {
      clearTimeout(timer);
      socket.close();
    };
    socket.on("error", reject);
    socket.on("open", () => {
      const filter = { kinds: [9735], "#p": [recipient], since: Math.floor(Date.now() / 1000) - 3600 };
      socket.send(JSON.stringify(["REQ", subId, filter]));
    });
    socket.on("message", (data) => {
      const [type, , event] = JSON.parse(data.toString()) as [string, string, NostrEvent];
      if (type !== "EVENT") return;
      if (event.tags.some((t) => t[0] === "description" && t[1] === zapRequest)) resolve(event);
    });
  });
  return { receipt, close };
}

const signer = new DefaultSparkSigner();
const mnemonic = await signer.generateMnemonic();
const { wallet: user } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, signer, options: { network: "REGTEST" } });
const identityPubkey = await user.getIdentityPublicKey();
const { nonce } = await getJson<{ nonce: string }>(`${baseUrl}/challenge`);
const signature = bytesToHex(await signer.signMessageWithIdentityKey(registrationDigest(nonce, domain)));
const { username, address } = await getJson<{ username: string; address: string }>(`${baseUrl}/users`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identityPubkey, nonce, signature }),
});
console.log(`registered ${address}`);

const payRequest = await getJson<{ callback: string; allowsNostr?: boolean; nostrPubkey?: string }>(
  `${baseUrl}/.well-known/lnurlp/${username}`,
);
check("payRequest advertises allowsNostr", payRequest.allowsNostr === true);
check("nostrPubkey is 64 hex characters", /^[0-9a-f]{64}$/.test(payRequest.nostrPubkey ?? ""), String(payRequest.nostrPubkey));
if (!payRequest.allowsNostr || !payRequest.nostrPubkey) {
  console.log("zaps are off on this server (is NOSTR_SECRET_KEY set?)");
  process.exit(1);
}

const sender = randomKeys();
const recipient = randomKeys().pubkey;
const amountMsat = amountSats * 1000;
const callback = (amount: number, zap: string) => `${payRequest.callback}?amount=${amount}&nostr=${encodeURIComponent(zap)}`;

const tampered = JSON.stringify({ ...JSON.parse(buildZapRequest(sender, recipient, amountMsat)), content: "edited" });
for (const [label, url] of [
  ["rejects a mismatched amount", callback(amountMsat, buildZapRequest(sender, recipient, amountMsat + 1000))],
  ["rejects a bad signature", callback(amountMsat, tampered)],
  ["rejects two p tags", callback(amountMsat, buildZapRequest(sender, recipient, amountMsat, [["p", randomKeys().pubkey]]))],
  ["rejects a P tag naming another signer", callback(amountMsat, buildZapRequest(sender, recipient, amountMsat, [["P", sender.pubkey]]))],
] as const) {
  const body = await getJson<{ status?: string; reason?: string }>(url);
  check(label, body.status === "ERROR", JSON.stringify(body));
}

const zapRequest = buildZapRequest(sender, recipient, amountMsat);
const { pr, status, reason } = await getJson<{ pr?: string; status?: string; reason?: string }>(callback(amountMsat, zapRequest));
check("callback returns a zap invoice", typeof pr === "string", `${status}: ${reason}`);
if (!pr) process.exit(1);
const invoice = invoiceSections(pr);
check("invoice description hash is sha256(zap request)", invoice.descriptionHash === createHash("sha256").update(zapRequest).digest("hex"));
check("invoice amount matches", invoice.amountMsat === String(amountMsat), invoice.amountMsat);

const watch = waitForReceipt(recipient, zapRequest);
if (payerMnemonic) {
  const { wallet: payer } = await SparkWallet.initialize({ mnemonicOrSeed: payerMnemonic, options: { network: "REGTEST" } });
  const payment = await payer.payLightningInvoice({ invoice: pr, maxFeeSats: 50 });
  console.log("payment status:", (payment as { status?: string }).status);
} else {
  console.log(`pay this invoice from a regtest wallet (or set PAYER_MNEMONIC):\n${pr}`);
}

const paidAt = Date.now();
try {
  const receipt = await watch.receipt;
  console.log(`receipt ${receipt.id} on ${relayUrl} after ${((Date.now() - paidAt) / 1000).toFixed(1)} s`);
  const tag = (name: string) => receipt.tags.find((t) => t[0] === name)?.[1];
  const description = tag("description") ?? "";
  const bolt11 = tag("bolt11") ?? "";
  check("receipt signature is valid", parseSignedEvent(JSON.stringify(receipt)) !== null);
  check("receipt is signed by the address's nostrPubkey", receipt.pubkey === payRequest.nostrPubkey, receipt.pubkey);
  check("receipt bolt11 is the paid invoice", bolt11 === pr);
  check(
    "sha256(description) matches the bolt11 description hash",
    invoiceSections(bolt11).descriptionHash === createHash("sha256").update(description).digest("hex"),
  );
  check("receipt amount matches the zap request amount tag", invoiceSections(bolt11).amountMsat === String(amountMsat));
  check("receipt P tag is the zap sender", tag("P") === sender.pubkey);
  check("receipt has a preimage", /^[0-9a-f]{64}$/.test(tag("preimage") ?? ""));
} catch (err) {
  check("receipt published", false, (err as Error).message);
} finally {
  watch.close();
}

console.log(failures === 0 ? "\nall zap checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
