import { BlockList, isIP } from "node:net";
import { type NostrEvent, type NostrKeys, deriveReceiptKeys, parseSignedEvent, signEvent } from "./nostr";

export const ZAP_REQUEST_KIND = 9734;
export const ZAP_RECEIPT_KIND = 9735;
export const MAX_ZAP_REQUEST_BYTES = 16 * 1024;
export const MAX_RECEIPT_RELAYS = 10;

/** Derives (and caches) each user's receipt signing key from the server's `NOSTR_SECRET_KEY`. */
export class ZapSigner {
  private readonly cache = new Map<string, NostrKeys>();

  constructor(private readonly serverSecret: Uint8Array) {}

  keysFor(identityPubkey: string): NostrKeys {
    const key = identityPubkey.toLowerCase();
    let keys = this.cache.get(key);
    if (!keys) {
      keys = deriveReceiptKeys(this.serverSecret, key);
      this.cache.set(key, keys);
    }
    return keys;
  }
}

export interface RelayPolicy {
  /** Allows ws:// and private or loopback hosts; for local development only. */
  allowPrivate: boolean;
}

const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip);
  if (family === 0) return false;
  return privateRanges.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Relay URLs come from the payer, so only public wss:// relays are dialled (resolved addresses are checked on connect). */
export function acceptedRelayUrl(raw: string, policy: RelayPolicy): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const schemeOk = url.protocol === "wss:" || (policy.allowPrivate && url.protocol === "ws:");
  if (!schemeOk || url.username || url.password) return null;
  if (!policy.allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host)) return null;
  }
  return url.toString();
}

export function receiptRelays(zapRequest: NostrEvent, policy: RelayPolicy): string[] {
  const listed = zapRequest.tags.find((tag) => tag[0] === "relays")?.slice(1) ?? [];
  const accepted = listed.map((raw) => acceptedRelayUrl(raw, policy)).filter((url): url is string => url !== null);
  return [...new Set(accepted)].slice(0, MAX_RECEIPT_RELAYS);
}

const tagsNamed = (event: NostrEvent, name: string) => event.tags.filter((tag) => tag[0] === name);

/** Checks a zap request per NIP-57 appendix D. `receiptPubkey` is the key that will sign this user's receipt. */
export function validateZapRequest(
  json: string,
  amountMsat: number,
  receiptPubkey: string,
  policy: RelayPolicy,
): { event: NostrEvent } | { error: string } {
  if (Buffer.byteLength(json) > MAX_ZAP_REQUEST_BYTES) return { error: "zap request too large" };
  const event = parseSignedEvent(json);
  if (!event) return { error: "invalid zap request: bad event or signature" };
  if (event.kind !== ZAP_REQUEST_KIND) return { error: "invalid zap request: wrong kind" };

  const p = tagsNamed(event, "p");
  if (p.length !== 1 || !/^[0-9a-f]{64}$/.test(p[0][1] ?? "")) return { error: "invalid zap request: needs exactly one p tag" };
  if (tagsNamed(event, "e").length > 1) return { error: "invalid zap request: more than one e tag" };
  const a = tagsNamed(event, "a");
  if (a.length > 1 || (a.length === 1 && !/^\d+:[0-9a-f]{64}:.*$/.test(a[0][1] ?? ""))) {
    return { error: "invalid zap request: bad a tag" };
  }
  const upperP = tagsNamed(event, "P");
  if (upperP.length > 1 || (upperP.length === 1 && upperP[0][1] !== receiptPubkey)) {
    return { error: "invalid zap request: P tag does not match the receipt signer" };
  }
  const amount = tagsNamed(event, "amount")[0]?.[1];
  if (amount !== undefined && amount !== String(amountMsat)) return { error: "invalid zap request: amount does not match" };
  if (receiptRelays(event, policy).length === 0) return { error: "invalid zap request: no usable wss:// relay" };
  return { event };
}

export interface SettledZap {
  zapRequest: string;
  pr: string;
  preimage: string;
  settledAt: number;
}

/** Builds the kind-9735 receipt (NIP-57 appendix E); `created_at` is the payment time, so retries yield the same event id. */
export function buildZapReceipt(zap: SettledZap, keys: NostrKeys): NostrEvent {
  const request = JSON.parse(zap.zapRequest) as NostrEvent;
  const copied = request.tags.filter((tag) => ["p", "e", "a", "k"].includes(tag[0]));
  return signEvent(
    {
      kind: ZAP_RECEIPT_KIND,
      created_at: Math.floor(zap.settledAt / 1000),
      content: "",
      tags: [...copied, ["P", request.pubkey], ["bolt11", zap.pr], ["description", zap.zapRequest], ["preimage", zap.preimage]],
    },
    keys,
  );
}
