import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSignedEvent } from "../src/nostr";
import { ZapSigner, acceptedRelayUrl, buildZapReceipt, isPrivateAddress, receiptRelays, validateZapRequest } from "../src/zaps";
import { RECIPIENT, randomKeys, zapRequest } from "./nostr-fixtures";

const PUBLIC = { allowPrivate: false };
const sender = randomKeys();
const signer = randomKeys();

describe("validateZapRequest", () => {
  it("accepts a well-formed zap request", () => {
    expect(validateZapRequest(zapRequest(sender), 21_000, signer.pubkey, PUBLIC)).toHaveProperty("event");
  });

  it("accepts one without an amount tag", () => {
    const json = zapRequest(sender, { tags: [["relays", "wss://relay.example.com"], ["p", RECIPIENT]] });
    expect(validateZapRequest(json, 99_000, signer.pubkey, PUBLIC)).toHaveProperty("event");
  });

  it("accepts a P tag that names the receipt signer", () => {
    const json = zapRequest(sender, { tags: [["relays", "wss://relay.example.com"], ["p", RECIPIENT], ["P", signer.pubkey]] });
    expect(validateZapRequest(json, 21_000, signer.pubkey, PUBLIC)).toHaveProperty("event");
  });

  const relays = ["relays", "wss://relay.example.com"];
  const p = ["p", RECIPIENT];
  it.each([
    ["a bad signature", JSON.stringify({ ...JSON.parse(zapRequest(sender)), content: "edited" }), /signature/],
    ["the wrong kind", zapRequest(sender, { kind: 1 }), /kind/],
    ["no p tag", zapRequest(sender, { tags: [relays] }), /p tag/],
    ["two p tags", zapRequest(sender, { tags: [relays, p, ["p", "cd".repeat(32)]] }), /p tag/],
    ["two e tags", zapRequest(sender, { tags: [relays, p, ["e", "ab".repeat(32)], ["e", "cd".repeat(32)]] }), /e tag/],
    ["a malformed a tag", zapRequest(sender, { tags: [relays, p, ["a", "nope"]] }), /a tag/],
    ["a P tag for another signer", zapRequest(sender, { tags: [relays, p, ["P", sender.pubkey]] }), /P tag/],
    ["a mismatched amount", zapRequest(sender, {}, 1_000), /amount/],
    ["no relays tag", zapRequest(sender, { tags: [p] }), /relay/],
    ["only private or insecure relays", zapRequest(sender, { tags: [["relays", "wss://127.0.0.1", "ws://relay.example.com"], p] }), /relay/],
    ["an oversized request", zapRequest(sender, { content: "x".repeat(17_000) }), /too large/],
  ])("rejects %s", (_name, json, error) => {
    const result = validateZapRequest(json, 21_000, signer.pubkey, PUBLIC);
    expect(result).toEqual({ error: expect.stringMatching(error) });
  });
});

describe("relay policy", () => {
  it.each([
    ["wss://relay.example.com", "wss://relay.example.com/"],
    ["wss://relay.example.com:444/path", "wss://relay.example.com:444/path"],
    ["ws://relay.example.com", null],
    ["https://relay.example.com", null],
    ["wss://user:pw@relay.example.com", null],
    ["wss://localhost", null],
    ["wss://10.1.2.3", null],
    ["wss://[::1]", null],
    ["wss://[::ffff:192.168.1.1]", null],
    ["wss://169.254.169.254", null],
    ["not a url", null],
  ])("treats %s as %s on mainnet", (raw, expected) => {
    expect(acceptedRelayUrl(raw, PUBLIC)).toBe(expected);
  });

  it("allows local relays for development", () => {
    expect(acceptedRelayUrl("ws://localhost:7777", { allowPrivate: true })).toBe("ws://localhost:7777/");
  });

  it("dedupes and caps the relays a receipt goes to", () => {
    const urls = Array.from({ length: 15 }, (_, i) => `wss://r${i}.example.com`);
    const event = JSON.parse(zapRequest(sender, { tags: [["relays", urls[0], ...urls], ["p", RECIPIENT]] }));
    expect(receiptRelays(event, PUBLIC)).toEqual(urls.slice(0, 10).map((u) => u + "/"));
  });

  it("recognises private addresses", () => {
    expect(["127.0.0.1", "192.168.0.10", "fd00::1", "fe80::1", "::ffff:10.0.0.1"].every(isPrivateAddress)).toBe(true);
    expect(["8.8.8.8", "2606:4700::1111", "relay.example.com"].some(isPrivateAddress)).toBe(false);
  });
});

describe("buildZapReceipt", () => {
  const request = zapRequest(sender, {
    tags: [["relays", "wss://relay.example.com"], ["p", RECIPIENT], ["e", "ab".repeat(32)], ["a", `30023:${RECIPIENT}:post`], ["k", "30023"], ["amount", "21000"]],
  });
  const zap = { zapRequest: request, pr: "lnbc210n1zap", preimage: "5a".repeat(32), settledAt: 1_700_000_123_456 };

  it("builds a NIP-57 receipt signed by the user's key", () => {
    const receipt = buildZapReceipt(zap, signer);
    expect(parseSignedEvent(JSON.stringify(receipt))).toEqual(receipt);
    expect(receipt).toMatchObject({ kind: 9735, pubkey: signer.pubkey, content: "", created_at: 1_700_000_123 });
    expect(receipt.tags).toEqual([
      ["p", RECIPIENT],
      ["e", "ab".repeat(32)],
      ["a", `30023:${RECIPIENT}:post`],
      ["k", "30023"],
      ["P", sender.pubkey],
      ["bolt11", "lnbc210n1zap"],
      ["description", request],
      ["preimage", "5a".repeat(32)],
    ]);
  });

  it("keeps the event id stable across retries", () => {
    expect(buildZapReceipt(zap, signer).id).toBe(buildZapReceipt(zap, signer).id);
  });

  it("commits to the zap request through the description tag", () => {
    const receipt = buildZapReceipt(zap, signer);
    const description = receipt.tags.find((t) => t[0] === "description")![1];
    expect(createHash("sha256").update(description).digest("hex")).toBe(createHash("sha256").update(request).digest("hex"));
  });

  it("signs each user's receipts with that user's key only", () => {
    const zapSigner = new ZapSigner(new Uint8Array(32).fill(7));
    const alice = zapSigner.keysFor("02" + "aa".repeat(32));
    const bob = zapSigner.keysFor("02" + "bb".repeat(32));
    const receipt = buildZapReceipt(zap, alice);
    expect(receipt.pubkey).toBe(alice.pubkey);
    expect(receipt.pubkey).not.toBe(bob.pubkey);
    // A receipt re-signed with a forged pubkey no longer verifies.
    expect(parseSignedEvent(JSON.stringify({ ...receipt, pubkey: bob.pubkey }))).toBeNull();
  });
});
