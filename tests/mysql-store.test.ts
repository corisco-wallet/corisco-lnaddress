import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDataCipher } from "../src/crypto";
import { migrateSqliteToMysql } from "../scripts/migrate-sqlite-to-mysql";
import { runMigrations } from "../src/migrations";
import { MysqlInvoiceStore } from "../src/mysql-invoice-store";
import { MysqlUserStore } from "../src/mysql-store";
import { HASH_A, describeInvoiceStore, newInvoice } from "./invoice-store-contract";
import { createLegacyDb, LEGACY_PUBKEY_A, LEGACY_PUBKEY_B } from "./legacy-fixture";
import { describeUserStore } from "./store-contract";

// Runs against a real MySQL; set TEST_MYSQL_URL=mysql://user:password@host:port/database (its tables are dropped).
const url = process.env.TEST_MYSQL_URL;
const cipher = createDataCipher(Buffer.alloc(32, 9));

describe.skipIf(!url)("MySQL", () => {
  let pool: Pool;

  // TRUNCATE isn't allowed on a table other tables reference, so empty them in order.
  const clearTables = async () => {
    await pool.query("DELETE FROM invoices");
    await pool.query("DELETE FROM users");
  };

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query("DROP TABLE IF EXISTS invoices");
    await pool.query("DROP TABLE IF EXISTS users");
    await pool.query("DROP TABLE IF EXISTS schema_migrations");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describeUserStore("MySQL", async () => {
    await clearTables();
    return { store: new MysqlUserStore(pool, cipher) };
  });

  describe("migrations", () => {
    it("can run again, and from two processes at once", async () => {
      const other = createPool(url!);
      try {
        await Promise.all([runMigrations(pool), runMigrations(other), runMigrations(pool)]);
      } finally {
        await other.end();
      }
      const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM schema_migrations");
      expect(rows.map((r) => r.id)).toEqual(["001-create-users", "002-create-invoices", "003-index-invoice-receive-request"]);
    });
  });

  describe("encryption at rest", () => {
    it("stores neither the username nor the pubkey in readable form", async () => {
      await clearTables();
      const store = new MysqlUserStore(pool, cipher);
      const pubkey = "02" + "cd".repeat(32);
      await store.getOrCreate(pubkey, () => "very-visible-name-1");
      const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM users");
      expect(rows).toHaveLength(1);
      const stored = Buffer.concat(["username_hash", "pubkey_hash", "username_enc", "pubkey_enc"].map((c) => Buffer.from(rows[0][c])));
      expect(stored.includes(Buffer.from("very-visible-name-1"))).toBe(false);
      expect(stored.includes(Buffer.from(pubkey))).toBe(false);
      expect(stored.includes(Buffer.from(pubkey, "hex"))).toBe(false);
    });

    it("refuses a row whose encrypted pubkey was swapped for another user's", async () => {
      await clearTables();
      const store = new MysqlUserStore(pool, cipher);
      await store.getOrCreate(LEGACY_PUBKEY_A, () => "alice-name-001");
      await store.getOrCreate(LEGACY_PUBKEY_B, () => "bob-name-002");
      await pool.query(
        "UPDATE users a JOIN users b ON a.id <> b.id SET a.pubkey_enc = b.pubkey_enc WHERE a.id = (SELECT MIN(id) FROM (SELECT id FROM users) t)",
      );
      await expect(store.getByUsername("alice-name-001")).rejects.toThrow();
    });

    it("refuses a row whose lookup hash was moved to another user", async () => {
      await clearTables();
      const store = new MysqlUserStore(pool, cipher);
      await store.getOrCreate(LEGACY_PUBKEY_A, () => "alice-name-001");
      const forged = cipher.lookupHash("username", "mallory-name-9");
      await pool.query("UPDATE users SET username_hash = ?", [forged]);
      await expect(store.getByUsername("mallory-name-9")).rejects.toThrow();
    });

    it("verifyKey accepts the right key and an empty table, and refuses a wrong key", async () => {
      await clearTables();
      await expect(new MysqlUserStore(pool, cipher).verifyKey()).resolves.toBeUndefined();
      await new MysqlUserStore(pool, cipher).getOrCreate(LEGACY_PUBKEY_A, () => "alice-name-001");
      await expect(new MysqlUserStore(pool, cipher).verifyKey()).resolves.toBeUndefined();
      await expect(new MysqlUserStore(pool, createDataCipher(Buffer.alloc(32, 10))).verifyKey()).rejects.toThrow("does not match");
    });

    it("cannot be read with a different key", async () => {
      await clearTables();
      await new MysqlUserStore(pool, cipher).getOrCreate(LEGACY_PUBKEY_A, () => "alice-name-001");
      const otherKey = new MysqlUserStore(pool, createDataCipher(Buffer.alloc(32, 10)));
      expect(await otherKey.getByUsername("alice-name-001")).toBeUndefined();
      expect(await otherKey.getByPubkey(LEGACY_PUBKEY_A)).toBeUndefined();
    });
  });

  describe("SQLite migration script", () => {
    it("moves every user across, encrypted, and is safe to run again", async () => {
      await clearTables();
      const dir = mkdtempSync(join(tmpdir(), "lnaddress-legacy-"));
      try {
        const path = join(dir, "lnaddress.db");
        createLegacyDb(path);
        const store = new MysqlUserStore(pool, cipher);
        expect(await migrateSqliteToMysql({ sqlitePath: path, store })).toEqual({ read: 2, inserted: 2, alreadyThere: 0 });
        expect(await store.getByUsername("keen-viper-124")).toEqual({ identityPubkey: LEGACY_PUBKEY_A, username: "keen-viper-124", active: true });
        expect(await store.getByPubkey(LEGACY_PUBKEY_B)).toEqual({ identityPubkey: LEGACY_PUBKEY_B, username: "calm-otter-001", active: false });
        expect(await migrateSqliteToMysql({ sqlitePath: path, store })).toEqual({ read: 2, inserted: 0, alreadyThere: 2 });

        const [rows] = await pool.query<RowDataPacket[]>("SELECT username_enc, pubkey_enc, created_at FROM users ORDER BY created_at");
        expect(rows.map((r) => Number(r.created_at))).toEqual([1_700_000_000_000, 1_700_000_001_000]);
        expect(Buffer.from(rows[0].username_enc).includes(Buffer.from("keen-viper-124"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describeInvoiceStore("MySQL", async () => {
    await clearTables();
    return { store: new MysqlInvoiceStore(pool, cipher), users: new MysqlUserStore(pool, cipher) };
  });

  describe("invoice encryption at rest", () => {
    it("stores neither the invoice nor the preimage in readable form, and binds them to their row", async () => {
      await clearTables();
      const users = new MysqlUserStore(pool, cipher);
      const store = new MysqlInvoiceStore(pool, cipher);
      await users.getOrCreate("02" + "ab".repeat(32), () => "payee-name-001");
      const preimage = "9c".repeat(32);
      await store.create(newInvoice({ pr: "lnbcrt-very-visible-invoice" }), 0);
      await store.markSettled(HASH_A, preimage, 5_000);

      const [rows] = await pool.query<RowDataPacket[]>("SELECT pr_enc, preimage_enc FROM invoices");
      const stored = Buffer.concat([Buffer.from(rows[0].pr_enc), Buffer.from(rows[0].preimage_enc)]);
      expect(stored.includes(Buffer.from("lnbcrt-very-visible-invoice"))).toBe(false);
      expect(stored.includes(Buffer.from(preimage))).toBe(false);
      expect(stored.includes(Buffer.from(preimage, "hex"))).toBe(false);

      const other = "d4".repeat(32);
      await store.create(newInvoice({ paymentHash: other }), 0);
      await pool.query("UPDATE invoices SET pr_enc = ? WHERE payment_hash = ?", [rows[0].pr_enc, Buffer.from(other, "hex")]);
      await expect(store.get(other)).rejects.toThrow();
    });
  });
});
