export interface UserRow {
  identityPubkey: string;
  username: string;
  active: boolean;
}

export interface LegacyUser extends UserRow {
  createdAt: number;
}

export interface UserStore {
  getByPubkey(identityPubkey: string): Promise<UserRow | undefined>;
  getByUsername(username: string): Promise<UserRow | undefined>;
  getOrCreate(identityPubkey: string, nameGenerator?: () => string): Promise<UserRow>;
  close(): Promise<void>;
}

/** What the one-off SQLite migration script needs; the running service never imports users. */
export interface ImportableUserStore extends UserStore {
  /** Adds the users that aren't stored yet and returns how many were added; safe to repeat. */
  importUsers(users: LegacyUser[]): Promise<number>;
}

export const MAX_NAME_ATTEMPTS = 10;
