import { afterEach, describe, expect, it } from "vitest";
import { signEvent } from "../src/nostr";
import { publishToRelay, publishToRelays } from "../src/relay";
import { startFakeRelay } from "./fake-relay";
import { randomKeys } from "./nostr-fixtures";

const keys = randomKeys();
const event = signEvent({ kind: 9735, created_at: 1_700_000_000, content: "", tags: [["p", "ab".repeat(32)]] }, keys);
const LOCAL = { keys, policy: { allowPrivate: true }, timeoutMs: 500 };

const relays: Awaited<ReturnType<typeof startFakeRelay>>[] = [];
async function relay(options?: Parameters<typeof startFakeRelay>[0]) {
  const started = await startFakeRelay(options);
  relays.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

describe("publishToRelay", () => {
  it("resolves when the relay accepts the event", async () => {
    const r = await relay();
    await publishToRelay(r.url, event, LOCAL);
    expect(r.received).toEqual([event]);
  });

  it("treats a duplicate as accepted", async () => {
    const r = await relay({ respond: () => [false, "duplicate: already have it"] });
    await expect(publishToRelay(r.url, event, LOCAL)).resolves.toBeUndefined();
  });

  it("rejects when the relay refuses the event", async () => {
    const r = await relay({ respond: () => [false, "blocked: no thanks"] });
    await expect(publishToRelay(r.url, event, LOCAL)).rejects.toThrow(/blocked/);
  });

  it("times out when the relay never answers", async () => {
    const r = await relay({ respond: () => null });
    await expect(publishToRelay(r.url, event, { ...LOCAL, timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  it("authenticates with the signing key when the relay requires it", async () => {
    const r = await relay({ requireAuth: true });
    await publishToRelay(r.url, event, LOCAL);
    expect(r.received).toEqual([event]);
    expect(r.auths).toEqual([expect.objectContaining({ kind: 22242, pubkey: keys.pubkey })]);
    expect(r.auths[0].tags).toContainEqual(["relay", r.url]);
  });

  it("refuses to dial a relay that resolves to a private address on mainnet", async () => {
    const r = await relay();
    await expect(publishToRelay(r.url, event, { ...LOCAL, policy: { allowPrivate: false } })).rejects.toThrow(/private address/);
    expect(r.received).toEqual([]);
  });
});

describe("publishToRelays", () => {
  it("counts the relays that accepted", async () => {
    const ok = await relay();
    const refuses = await relay({ respond: () => [false, "blocked:"] });
    const result = await publishToRelays([ok.url, refuses.url, "ws://localhost:1"], event, LOCAL);
    expect(result.accepted).toBe(1);
    expect(result.failures).toEqual([
      { relay: refuses.url, reason: "rejected the event: blocked:" },
      { relay: "ws://localhost:1", reason: expect.any(String) },
    ]);
  });
});
