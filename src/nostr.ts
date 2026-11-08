import { createHash, createHmac } from "node:crypto";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type EventTemplate = Pick<NostrEvent, "created_at" | "kind" | "tags" | "content">;

export interface NostrKeys {
  secretKey: Uint8Array;
  /** Hex, x-only (BIP-340), as it appears in events and in `nostrPubkey`. */
  pubkey: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function eventId(event: Omit<NostrEvent, "id" | "sig">): string {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return createHash("sha256").update(serialized).digest("hex");
}

export function keysFromSecret(secretKey: Uint8Array): NostrKeys {
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

export function signEvent(template: EventTemplate, keys: NostrKeys): NostrEvent {
  const unsigned = { ...template, pubkey: keys.pubkey };
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), keys.secretKey)) };
}

/** Parses untrusted JSON into an event whose id and signature check out, or returns null. */
export function parseSignedEvent(json: string): NostrEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isEventShape(value)) return null;
  if (eventId(value) !== value.id) return null;
  try {
    return schnorr.verify(hexToBytes(value.sig), hexToBytes(value.id), hexToBytes(value.pubkey)) ? value : null;
  } catch {
    return null;
  }
}

function isEventShape(value: unknown): value is NostrEvent {
  const e = value as Record<string, unknown> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.id === "string" &&
    HEX64.test(e.id) &&
    typeof e.pubkey === "string" &&
    HEX64.test(e.pubkey) &&
    typeof e.sig === "string" &&
    HEX128.test(e.sig) &&
    Number.isSafeInteger(e.created_at) &&
    Number.isSafeInteger(e.kind) &&
    typeof e.content === "string" &&
    Array.isArray(e.tags) &&
    e.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
  );
}

/** Accepts an `nsec1…` or 64 hex characters. */
export function parseNostrSecretKey(value: string): Uint8Array {
  let bytes: Uint8Array;
  if (value.startsWith("nsec1")) {
    let decoded;
    try {
      decoded = bech32.decodeToBytes(value as `${string}1${string}`);
    } catch {
      throw new Error("NOSTR_SECRET_KEY is not a valid nsec");
    }
    if (decoded.prefix !== "nsec") throw new Error("NOSTR_SECRET_KEY is not a valid nsec");
    bytes = decoded.bytes;
  } else if (/^[0-9a-fA-F]{64}$/.test(value)) {
    bytes = hexToBytes(value.toLowerCase());
  } else {
    throw new Error("NOSTR_SECRET_KEY must be an nsec or 64 hex characters");
  }
  if (!secp256k1.utils.isValidSecretKey(bytes)) throw new Error("NOSTR_SECRET_KEY is not a valid secp256k1 key");
  return bytes;
}

export function npubEncode(pubkeyHex: string): string {
  return bech32.encode("npub", bech32.toWords(hexToBytes(pubkeyHex)));
}

// Frozen: clients check receipts against the key an address advertises now, so changing this breaks every past receipt.
const RECEIPT_KEY_LABEL = "corisco-lnaddress/zap-receipt-key/v1:";

/**
 * Each user's receipts are signed with their own key, derived from the server key and their identity pubkey,
 * so one user's receipts never validate under another user's address.
 */
export function deriveReceiptKeys(serverSecret: Uint8Array, identityPubkey: string): NostrKeys {
  for (let counter = 0; counter < 256; counter++) {
    const candidate = createHmac("sha256", serverSecret)
      .update(RECEIPT_KEY_LABEL + identityPubkey.toLowerCase())
      .update(Uint8Array.of(counter))
      .digest();
    if (secp256k1.utils.isValidSecretKey(candidate)) return keysFromSecret(new Uint8Array(candidate));
  }
  throw new Error("could not derive a valid receipt key");
}
