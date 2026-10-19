import { beforeEach, describe, expect, it } from "vitest";
import type { ImportableUserStore, LegacyUser } from "../src/db";

const PUBKEY_A = "02" + "aa".repeat(32);
const PUBKEY_B = "03" + "bb".repeat(32);

const legacy = (overrides: Partial<LegacyUser> = {}): LegacyUser => ({
  identityPubkey: PUBKEY_A,
  username: "old-user-001",
  createdAt: 1_700_000_000_000,
  active: true,
  ...overrides,
});

/** Behaviour every UserStore must have, whatever it stores the rows in. */
export function describeUserStore(name: string, create: () => Promise<{ store: ImportableUserStore; cleanup?: () => Promise<void> }>) {
  describe(`${name} user store`, () => {
    let store: ImportableUserStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      ({ store, cleanup } = await create());
      return async () => {
        await cleanup?.();
      };
    });

    it("assigns a username once per pubkey and finds it both ways", async () => {
      const first = await store.getOrCreate(PUBKEY_A);
      const again = await store.getOrCreate(PUBKEY_A);
      expect(again).toEqual(first);
      expect(first.active).toBe(true);
      expect(await store.getByUsername(first.username)).toEqual(first);
      expect(await store.getByPubkey(PUBKEY_A)).toEqual(first);
      expect(await store.getByPubkey(PUBKEY_B)).toBeUndefined();
      expect(await store.getByUsername("nobody-here-000")).toBeUndefined();
    });

    it("retries when the generated name is taken", async () => {
      await store.getOrCreate(PUBKEY_A, () => "taken-name-001");
      const names = ["taken-name-001", "free-name-002"];
      const user = await store.getOrCreate(PUBKEY_B, () => names.shift()!);
      expect(user.username).toBe("free-name-002");
    });

    it("gives up after repeated collisions", async () => {
      await store.getOrCreate(PUBKEY_A, () => "taken-name-001");
      await expect(store.getOrCreate(PUBKEY_B, () => "taken-name-001")).rejects.toThrow("unique username");
    });

    it("treats usernames case-insensitively", async () => {
      await store.getOrCreate(PUBKEY_A, () => "Mixed-Case-001");
      expect((await store.getByUsername("MIXED-case-001"))?.identityPubkey).toBe(PUBKEY_A);
    });

    it("returns one username when the same pubkey registers concurrently", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => store.getOrCreate(PUBKEY_A)));
      expect(new Set(results.map((r) => r.username)).size).toBe(1);
    });

    it("imports legacy users, keeps their data, and does nothing when repeated", async () => {
      const users = [legacy(), legacy({ identityPubkey: PUBKEY_B, username: "Gone-User-002", active: false })];
      expect(await store.importUsers(users)).toBe(2);
      expect(await store.getByUsername("old-user-001")).toEqual({ identityPubkey: PUBKEY_A, username: "old-user-001", active: true });
      expect(await store.getByPubkey(PUBKEY_B)).toEqual({ identityPubkey: PUBKEY_B, username: "gone-user-002", active: false });
      expect(await store.importUsers(users)).toBe(0);
    });
  });
}
