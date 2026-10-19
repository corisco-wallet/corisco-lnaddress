import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DataCipher } from "./crypto";
import { MAX_NAME_ATTEMPTS, type ImportableUserStore, type LegacyUser, type UserRow } from "./db";
import { generateUsername } from "./usernames";

const USERNAME_KEY = "uq_username_hash";
const PUBKEY_KEY = "uq_pubkey_hash";

interface UserRecord extends RowDataPacket {
  username_hash: Buffer;
  pubkey_hash: Buffer;
  username_enc: Buffer;
  pubkey_enc: Buffer;
  active: number;
}

function duplicateKeyMessage(err: unknown): string | null {
  const e = err as { code?: string; sqlMessage?: string };
  return e?.code === "ER_DUP_ENTRY" ? (e.sqlMessage ?? "") : null;
}

export class MysqlUserStore implements ImportableUserStore {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: DataCipher,
  ) {}

  async getByPubkey(identityPubkey: string): Promise<UserRow | undefined> {
    return this.find("pubkey_hash", this.cipher.lookupHash("pubkey", identityPubkey));
  }

  async getByUsername(username: string): Promise<UserRow | undefined> {
    return this.find("username_hash", this.cipher.lookupHash("username", username.toLowerCase()));
  }

  async getOrCreate(identityPubkey: string, nameGenerator: () => string = generateUsername): Promise<UserRow> {
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const existing = await this.getByPubkey(identityPubkey);
      if (existing) return existing;
      const username = nameGenerator().toLowerCase();
      try {
        await this.insert(identityPubkey, username, Date.now());
        return { identityPubkey, username, active: true };
      } catch (err) {
        const duplicate = duplicateKeyMessage(err);
        if (duplicate === null) throw err;
        // Another request registered this pubkey first, or the name is taken: loop and look again or pick a new name.
        if (duplicate.includes(PUBKEY_KEY) || duplicate.includes(USERNAME_KEY)) continue;
        throw err;
      }
    }
    throw new Error("could not allocate a unique username");
  }

  async importUsers(users: LegacyUser[]): Promise<number> {
    let inserted = 0;
    for (const user of users) {
      try {
        await this.insert(user.identityPubkey, user.username.toLowerCase(), user.createdAt, user.active);
        inserted++;
      } catch (err) {
        if (duplicateKeyMessage(err) === null) throw err;
      }
    }
    return inserted;
  }

  /** Fails if the key can't read the rows already stored, so a wrong key never silently starts a second dataset. */
  async verifyKey(sample = 20): Promise<void> {
    const [rows] = await this.pool.execute<UserRecord[]>(
      `SELECT username_hash, pubkey_hash, username_enc, pubkey_enc, active FROM users ORDER BY id LIMIT ${Math.trunc(sample)}`,
    );
    try {
      for (const row of rows) this.toUser(row);
    } catch {
      throw new Error("DATA_ENCRYPTION_KEY does not match the users already stored in MySQL");
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async insert(identityPubkey: string, username: string, createdAt: number, active = true): Promise<void> {
    const usernameHash = this.cipher.lookupHash("username", username);
    const pubkeyHash = this.cipher.lookupHash("pubkey", identityPubkey);
    const context = Buffer.concat([usernameHash, pubkeyHash]);
    await this.pool.execute(
      "INSERT INTO users (username_hash, pubkey_hash, username_enc, pubkey_enc, created_at, active) VALUES (?, ?, ?, ?, ?, ?)",
      [
        usernameHash,
        pubkeyHash,
        this.cipher.encrypt("username", username, context),
        this.cipher.encrypt("pubkey", identityPubkey, context),
        createdAt,
        active ? 1 : 0,
      ],
    );
  }

  private async find(column: "username_hash" | "pubkey_hash", hash: Buffer): Promise<UserRow | undefined> {
    const [rows] = await this.pool.execute<UserRecord[]>(
      `SELECT username_hash, pubkey_hash, username_enc, pubkey_enc, active FROM users WHERE ${column} = ?`,
      [hash],
    );
    return rows[0] ? this.toUser(rows[0]) : undefined;
  }

  private toUser(row: UserRecord): UserRow {
    const context = Buffer.concat([row.username_hash, row.pubkey_hash]);
    const username = this.cipher.decrypt("username", row.username_enc, context);
    const identityPubkey = this.cipher.decrypt("pubkey", row.pubkey_enc, context);
    const consistent =
      this.cipher.lookupHash("username", username).equals(row.username_hash) &&
      this.cipher.lookupHash("pubkey", identityPubkey).equals(row.pubkey_hash);
    if (!consistent) throw new Error("a stored user record failed verification");
    return { identityPubkey, username, active: row.active === 1 };
  }
}
