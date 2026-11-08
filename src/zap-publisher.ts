import type { InvoiceStore, ZapReceiptJob } from "./invoice-store";
import type { NostrEvent, NostrKeys } from "./nostr";
import { type PublishOptions, publishToRelays } from "./relay";
import { type RelayPolicy, type ZapSigner, buildZapReceipt, receiptRelays } from "./zaps";

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

export type Publish = (relays: string[], event: NostrEvent, options: PublishOptions) => Promise<number>;

export interface ZapPublisherOptions {
  store: InvoiceStore;
  signer: ZapSigner;
  policy: RelayPolicy;
  publish?: Publish;
  now?: () => number;
  log?: Pick<Console, "error" | "warn">;
  batchSize?: number;
  /** A receipt that still hasn't reached any relay this long after payment is given up. */
  giveUpAfterMs?: number;
}

/** 30 s, growing 1.5x per failed attempt, capped at an hour. */
export function retryDelay(attempts: number): number {
  return Math.min(30 * SECOND * 1.5 ** (attempts - 1), HOUR);
}

/** Publishes the kind-9735 receipt of every settled zap, retrying until a relay accepts it. */
export class ZapPublisher {
  private readonly publish: Publish;
  private readonly now: () => number;
  private readonly log: Pick<Console, "error" | "warn">;
  private readonly batchSize: number;
  private readonly giveUpAfterMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = true;
  private everyMs = 30 * SECOND;

  constructor(private readonly options: ZapPublisherOptions) {
    this.publish = options.publish ?? publishToRelays;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console;
    this.batchSize = options.batchSize ?? 20;
    this.giveUpAfterMs = options.giveUpAfterMs ?? 14 * DAY;
  }

  /** One pass over the receipts that are due. */
  async publishDue(): Promise<void> {
    const jobs = await this.options.store.dueZapReceipts(this.now(), this.batchSize);
    await Promise.all(jobs.map((job) => this.attempt(job)));
  }

  start({ everyMs = 30 * SECOND } = {}): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.everyMs = everyMs;
    this.kick();
  }

  /** Runs a pass now, e.g. right after an invoice settles; polling still covers anything this misses. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.running = this.publishDue()
      .catch((err) => this.log.error("zap receipt pass failed:", err))
      .finally(() => {
        this.running = undefined;
        if (this.stopped) return;
        if (this.again) {
          this.again = false;
          this.kick();
        } else {
          this.timer = setTimeout(() => this.kick(), this.everyMs);
        }
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Any failure, including a throw, counts as an attempt, so a job that keeps failing backs off and is eventually given up. */
  private async attempt(job: ZapReceiptJob): Promise<void> {
    try {
      if (await this.publishOne(job)) return;
    } catch (err) {
      this.log.error("zap receipt failed:", err);
    }
    await this.recordFailure(job).catch((err) => this.log.error("could not record a failed zap receipt:", err));
  }

  private async publishOne(job: ZapReceiptJob): Promise<boolean> {
    if ("error" in job) throw job.error;
    const keys: NostrKeys = this.options.signer.keysFor(job.receiverIdentityPubkey);
    const receipt = buildZapReceipt(job, keys);
    const relays = receiptRelays(JSON.parse(job.zapRequest), this.options.policy);
    const accepted = await this.publish(relays, receipt, { keys, policy: this.options.policy });
    if (accepted === 0) return false;
    await this.options.store.zapReceiptPublished(job.paymentHash, JSON.stringify(receipt));
    return true;
  }

  private async recordFailure(job: ZapReceiptJob): Promise<void> {
    const attempts = job.attempts + 1;
    const now = this.now();
    const giveUp = now - job.settledAt > this.giveUpAfterMs;
    if (giveUp) this.log.warn(`giving up on a zap receipt not published after ${attempts} attempts`);
    await this.options.store.zapReceiptFailed(job.paymentHash, attempts, giveUp ? null : now + retryDelay(attempts));
  }
}
