import { describe, expect, it } from "vitest";
import { deriveReceiptKeys, eventId, npubEncode, parseNostrSecretKey, parseSignedEvent, signEvent } from "../src/nostr";
import { loadConfig } from "../src/config";
import { randomKeys } from "./nostr-fixtures";

// NIP-19 test vectors.
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const NSEC_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
const NPUB_HEX = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";

describe("nostr keys", () => {
  it("parses an nsec or hex secret key", () => {
    expect(Buffer.from(parseNostrSecretKey(NSEC)).toString("hex")).toBe(NSEC_HEX);
    expect(Buffer.from(parseNostrSecretKey(NSEC_HEX.toUpperCase())).toString("hex")).toBe(NSEC_HEX);
  });

  it.each([
    ["an npub", NPUB],
    ["a mangled nsec", NSEC.slice(0, -1) + "x"],
    ["short hex", "ab".repeat(31)],
    ["zero", "00".repeat(32)],
    ["above the curve order", "ff".repeat(32)],
  ])("rejects %s", (_name, value) => {
    expect(() => parseNostrSecretKey(value)).toThrow(/NOSTR_SECRET_KEY/);
  });

  it("encodes an npub", () => {
    expect(npubEncode(NPUB_HEX)).toBe(NPUB);
  });

  it("derives a stable receipt key per user, unrelated to the server key", () => {
    const server = parseNostrSecretKey(NSEC);
    const alice = deriveReceiptKeys(server, "02" + "aa".repeat(32));
    expect(deriveReceiptKeys(server, "02" + "AA".repeat(32)).pubkey).toBe(alice.pubkey);
    expect(deriveReceiptKeys(server, "02" + "bb".repeat(32)).pubkey).not.toBe(alice.pubkey);
    expect(deriveReceiptKeys(parseNostrSecretKey("11".repeat(32)), "02" + "aa".repeat(32)).pubkey).not.toBe(alice.pubkey);
    expect(alice.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("nostr events", () => {
  it("signs events that verify, and rejects tampered ones", () => {
    const event = signEvent({ kind: 1, created_at: 1, content: "hi \"there\"\n", tags: [["t", "x"]] }, randomKeys());
    expect(event.id).toBe(eventId(event));
    expect(parseSignedEvent(JSON.stringify(event))).toEqual(event);
    expect(parseSignedEvent(JSON.stringify({ ...event, content: "changed" }))).toBeNull();
    expect(parseSignedEvent(JSON.stringify({ ...event, id: eventId({ ...event, content: "changed" }), content: "changed" }))).toBeNull();
  });

  it.each([["not json", "{"], ["an array", "[]"], ["missing fields", '{"kind":9734}'], ["non-string tags", '{"tags":[[1]]}']])(
    "rejects %s",
    (_name, json) => {
      expect(parseSignedEvent(json)).toBeNull();
    },
  );
});

describe("NOSTR_SECRET_KEY config", () => {
  const base = {
    PUBLIC_BASE_URL: "https://pay.example.test",
    LNADDRESS_DOMAIN: "example.test",
    DB_HOST: "h",
    DB_USER: "u",
    DB_PASSWORD: "p",
    DB_NAME: "n",
    DATA_ENCRYPTION_KEY: "00".repeat(32),
    SERVER_MNEMONIC: "m",
  };

  it("leaves zaps off without a key and parses one when set", () => {
    expect(loadConfig(base).nostrSecretKey).toBeUndefined();
    expect(Buffer.from(loadConfig({ ...base, NOSTR_SECRET_KEY: ` ${NSEC} ` }).nostrSecretKey!).toString("hex")).toBe(NSEC_HEX);
  });

  it("fails at startup on an unusable key", () => {
    expect(() => loadConfig({ ...base, NOSTR_SECRET_KEY: NPUB })).toThrow(/NOSTR_SECRET_KEY/);
  });
});
