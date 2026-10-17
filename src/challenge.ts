import { randomBytes } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const MAX_OUTSTANDING = 10_000;

export class ChallengeStore {
  private readonly nonces = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(): { nonce: string; expiresAt: number } {
    this.purgeExpired();
    if (this.nonces.size >= MAX_OUTSTANDING) throw new Error("too many outstanding challenges");
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = this.now() + TTL_MS;
    this.nonces.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  /** Single use: a nonce is removed whether or not the caller's signature turns out valid. */
  consume(nonce: string): boolean {
    const expiresAt = this.nonces.get(nonce);
    if (expiresAt === undefined) return false;
    this.nonces.delete(nonce);
    return expiresAt > this.now();
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [nonce, expiresAt] of this.nonces) if (expiresAt <= now) this.nonces.delete(nonce);
  }
}
