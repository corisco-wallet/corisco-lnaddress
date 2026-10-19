import Database from "better-sqlite3";

export const LEGACY_PUBKEY_A = "02" + "aa".repeat(32);
export const LEGACY_PUBKEY_B = "03" + "bb".repeat(32);

/** Creates a database with the exact schema and some rows of the SQLite version of the service. */
export function createLegacyDb(path: string): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE users (
    identity_pubkey TEXT PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at      INTEGER NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1
  )`);
  const insert = db.prepare("INSERT INTO users (identity_pubkey, username, created_at, active) VALUES (?, ?, ?, ?)");
  insert.run(LEGACY_PUBKEY_A, "keen-viper-124", 1_700_000_000_000, 1);
  insert.run(LEGACY_PUBKEY_B, "calm-otter-001", 1_700_000_001_000, 0);
  db.close();
}
