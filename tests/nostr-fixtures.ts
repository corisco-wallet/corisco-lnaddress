import { schnorr } from "@noble/curves/secp256k1.js";
import { type EventTemplate, type NostrKeys, keysFromSecret, signEvent } from "../src/nostr";

export const RECIPIENT = "32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245";

export function randomKeys(): NostrKeys {
  return keysFromSecret(schnorr.utils.randomSecretKey());
}

export function zapRequest(
  sender: NostrKeys,
  { tags, ...rest }: Partial<EventTemplate> & { tags?: string[][] } = {},
  amountMsat = 21_000,
): string {
  const event = signEvent(
    {
      kind: 9734,
      created_at: 1_700_000_000,
      content: "great post",
      tags: tags ?? [
        ["relays", "wss://relay.example.com", "wss://nos.example.org"],
        ["amount", String(amountMsat)],
        ["p", RECIPIENT],
        ["e", "ab".repeat(32)],
      ],
      ...rest,
    },
    sender,
  );
  return JSON.stringify(event);
}
