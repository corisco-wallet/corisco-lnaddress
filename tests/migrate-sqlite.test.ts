import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSqliteToMysql, readLegacyUsers } from "../scripts/migrate-sqlite-to-mysql";
import { createLegacyDb, LEGACY_PUBKEY_A as PUBKEY_A, LEGACY_PUBKEY_B as PUBKEY_B } from "./legacy-fixture";
import { MemoryUserStore } from "./memory-store";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lnaddress-legacy-"));
  path = join(dir, "lnaddress.db");
  createLegacyDb(path);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readLegacyUsers", () => {
  it("reads every row of the old schema", () => {
    expect(readLegacyUsers(path)).toEqual([
      { identityPubkey: PUBKEY_A, username: "keen-viper-124", createdAt: 1_700_000_000_000, active: true },
      { identityPubkey: PUBKEY_B, username: "calm-otter-001", createdAt: 1_700_000_001_000, active: false },
    ]);
  });

  it("fails on a missing file instead of creating an empty database", () => {
    expect(() => readLegacyUsers(join(dir, "missing.db"))).toThrow();
  });
});

describe("migrateSqliteToMysql", () => {
  it("copies all users, verifies them, and a second run adds nothing", async () => {
    const store = new MemoryUserStore();
    expect(await migrateSqliteToMysql({ sqlitePath: path, store })).toEqual({ read: 2, inserted: 2, alreadyThere: 0 });
    expect(await store.getByUsername("keen-viper-124")).toEqual({ identityPubkey: PUBKEY_A, username: "keen-viper-124", active: true });
    expect(await store.getByPubkey(PUBKEY_B)).toEqual({ identityPubkey: PUBKEY_B, username: "calm-otter-001", active: false });
    expect(await migrateSqliteToMysql({ sqlitePath: path, store })).toEqual({ read: 2, inserted: 0, alreadyThere: 2 });
  });

  it("writes nothing in a dry run and reports what would be added", async () => {
    const store = new MemoryUserStore();
    await store.importUsers([{ identityPubkey: PUBKEY_A, username: "keen-viper-124", createdAt: 1, active: true }]);
    expect(await migrateSqliteToMysql({ sqlitePath: path, store, dryRun: true })).toEqual({ read: 2, inserted: 0, alreadyThere: 1 });
    expect(await store.getByPubkey(PUBKEY_B)).toBeUndefined();
  });

  it("keeps a user who already exists and adds the rest", async () => {
    const store = new MemoryUserStore();
    await store.importUsers([{ identityPubkey: PUBKEY_A, username: "keen-viper-124", createdAt: 1, active: true }]);
    expect(await migrateSqliteToMysql({ sqlitePath: path, store })).toEqual({ read: 2, inserted: 1, alreadyThere: 1 });
  });

  it("fails when a user's name is already taken by someone else", async () => {
    const store = new MemoryUserStore();
    await store.importUsers([{ identityPubkey: "02" + "ee".repeat(32), username: "keen-viper-124", createdAt: 1, active: true }]);
    await expect(migrateSqliteToMysql({ sqlitePath: path, store })).rejects.toThrow("did not read back");
  });
});
