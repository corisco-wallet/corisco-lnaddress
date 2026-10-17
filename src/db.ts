import Database from "better-sqlite3";
import { generateUsername } from "./usernames";

export interface UserRow {
  identityPubkey: string;
  username: string;
  active: boolean;
}

const MAX_NAME_ATTEMPTS = 10;

export class UserStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        identity_pubkey TEXT PRIMARY KEY,
        username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at      INTEGER NOT NULL,
        active          INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  getByPubkey(identityPubkey: string): UserRow | undefined {
    return this.toRow(this.db.prepare("SELECT * FROM users WHERE identity_pubkey = ?").get(identityPubkey));
  }

  getByUsername(username: string): UserRow | undefined {
    return this.toRow(this.db.prepare("SELECT * FROM users WHERE username = ?").get(username.toLowerCase()));
  }

  getOrCreate(identityPubkey: string, nameGenerator: () => string = generateUsername): UserRow {
    const insert = this.db.prepare("INSERT INTO users (identity_pubkey, username, created_at) VALUES (?, ?, ?)");
    const run = this.db.transaction((): UserRow => {
      const existing = this.getByPubkey(identityPubkey);
      if (existing) return existing;
      for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
        const username = nameGenerator();
        if (this.getByUsername(username)) continue;
        insert.run(identityPubkey, username, Date.now());
        return { identityPubkey, username, active: true };
      }
      throw new Error("could not allocate a unique username");
    });
    return run();
  }

  close(): void {
    this.db.close();
  }

  private toRow(raw: unknown): UserRow | undefined {
    if (!raw) return undefined;
    const row = raw as { identity_pubkey: string; username: string; active: number };
    return { identityPubkey: row.identity_pubkey, username: row.username, active: row.active === 1 };
  }
}
