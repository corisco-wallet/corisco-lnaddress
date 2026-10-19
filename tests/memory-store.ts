import type { ImportableUserStore, LegacyUser, UserRow } from "../src/db";
import { MAX_NAME_ATTEMPTS } from "../src/db";
import { generateUsername } from "../src/usernames";

export class MemoryUserStore implements ImportableUserStore {
  private readonly byPubkey = new Map<string, UserRow>();
  private readonly byUsername = new Map<string, UserRow>();

  async getByPubkey(identityPubkey: string) {
    return this.byPubkey.get(identityPubkey);
  }

  async getByUsername(username: string) {
    return this.byUsername.get(username.toLowerCase());
  }

  async getOrCreate(identityPubkey: string, nameGenerator: () => string = generateUsername) {
    const existing = this.byPubkey.get(identityPubkey);
    if (existing) return existing;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const username = nameGenerator().toLowerCase();
      if (this.byUsername.has(username)) continue;
      return this.add({ identityPubkey, username, active: true });
    }
    throw new Error("could not allocate a unique username");
  }

  async importUsers(users: LegacyUser[]) {
    let inserted = 0;
    for (const user of users) {
      const username = user.username.toLowerCase();
      if (this.byPubkey.has(user.identityPubkey) || this.byUsername.has(username)) continue;
      this.add({ identityPubkey: user.identityPubkey, username, active: user.active });
      inserted++;
    }
    return inserted;
  }

  async close() {}

  private add(user: UserRow) {
    this.byPubkey.set(user.identityPubkey, user);
    this.byUsername.set(user.username, user);
    return user;
  }
}
