// One-off: copies the users of the old SQLite database into the MySQL database, encrypted.
//
//   tsx scripts/migrate-sqlite-to-mysql.ts --sqlite /data/lnaddress.db [--dry-run]
//
// MySQL and the key come from the same variables as the service: DB_HOST, DB_PORT, DB_USER,
// DB_PASSWORD, DB_NAME and DATA_ENCRYPTION_KEY. Safe to run again: users already in MySQL are skipped.

import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createPool } from "mysql2/promise";
import { createDataCipher, parseDataKey } from "../src/crypto";
import type { ImportableUserStore, LegacyUser } from "../src/db";
import { runMigrations } from "../src/migrations";
import { MysqlUserStore } from "../src/mysql-store";

interface LegacyRow {
  identity_pubkey: string;
  username: string;
  created_at: number;
  active: number;
}

export function readLegacyUsers(path: string): LegacyUser[] {
  const db = new Database(path, { fileMustExist: true, readonly: true });
  try {
    const rows = db.prepare("SELECT identity_pubkey, username, created_at, active FROM users").all() as LegacyRow[];
    return rows.map((row) => ({
      identityPubkey: row.identity_pubkey,
      username: row.username,
      createdAt: row.created_at,
      active: row.active === 1,
    }));
  } finally {
    db.close();
  }
}

export interface MigrationResult {
  read: number;
  inserted: number;
  alreadyThere: number;
}

/** Copies every user into the store, then checks each one reads back unchanged. With `dryRun` nothing is written. */
export async function migrateSqliteToMysql({
  sqlitePath,
  store,
  dryRun = false,
}: {
  sqlitePath: string;
  store: ImportableUserStore;
  dryRun?: boolean;
}): Promise<MigrationResult> {
  const users = readLegacyUsers(sqlitePath);
  const usernames = new Set(users.map((u) => u.username.toLowerCase()));
  if (usernames.size !== users.length) throw new Error("the SQLite database has usernames that only differ by case");

  const missing: LegacyUser[] = [];
  for (const user of users) {
    if (!(await store.getByPubkey(user.identityPubkey))) missing.push(user);
  }
  if (dryRun) return { read: users.length, inserted: 0, alreadyThere: users.length - missing.length };

  const inserted = await store.importUsers(missing);
  for (const user of users) {
    const byName = await store.getByUsername(user.username);
    const byPubkey = await store.getByPubkey(user.identityPubkey);
    const matches = byName?.identityPubkey === user.identityPubkey && byPubkey?.username === user.username.toLowerCase();
    if (!matches) throw new Error(`user ${user.username} did not read back correctly after the import`);
  }
  return { read: users.length, inserted, alreadyThere: users.length - inserted };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const sqlitePath = argument("--sqlite") ?? required("SQLITE_PATH");
  const dryRun = process.argv.includes("--dry-run");
  const pool = createPool({
    host: required("DB_HOST"),
    port: Number(process.env.DB_PORT ?? 3306),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
    charset: "utf8mb4",
  });
  try {
    await runMigrations(pool);
    const store = new MysqlUserStore(pool, createDataCipher(parseDataKey(required("DATA_ENCRYPTION_KEY"))));
    await store.verifyKey();
    const { read, inserted, alreadyThere } = await migrateSqliteToMysql({ sqlitePath, store, dryRun });
    console.log(
      dryRun
        ? `dry run: ${read} users in SQLite, ${alreadyThere} already in MySQL, ${read - alreadyThere} would be added`
        : `done: ${read} users in SQLite, ${inserted} added, ${alreadyThere} already in MySQL, all verified`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
