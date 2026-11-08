import { describe, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => ({ addresses: [] as { address: string; family: number }[] }));
vi.mock("node:dns", () => ({
  lookup: (_host: string, _options: object, callback: (err: null, addresses: unknown) => void) => callback(null, resolved.addresses),
}));

const { publicOnlyLookup } = await import("../src/relay");

const lookup = (options: object = {}) =>
  new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
    publicOnlyLookup("relay.example.com", options, (err, address) => resolve({ err, address })),
  );

describe("publicOnlyLookup", () => {
  it("fails instead of throwing when the resolver returns no address", async () => {
    resolved.addresses = [];
    expect((await lookup()).err).toMatchObject({ code: "ENOTFOUND" });
  });

  it("refuses a hostname with any private address", async () => {
    resolved.addresses = [{ address: "8.8.8.8", family: 4 }, { address: "64:ff9b::a00:5", family: 6 }];
    expect((await lookup()).err).toMatchObject({ code: "EPRIVATE" });
  });

  it("returns the first public address", async () => {
    resolved.addresses = [{ address: "8.8.8.8", family: 4 }];
    expect(await lookup()).toEqual({ err: null, address: "8.8.8.8" });
  });
});
