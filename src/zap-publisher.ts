import type { InvoiceStore, ZapReceiptJob } from "./invoice-store";
import type { NostrEvent, NostrKeys } from "./nostr";
import { type PublishOptions, type PublishResult, publishToRelays } from "./relay";
import { type RelayPolicy, type ZapSigner, buildZapReceipt, receiptRelays } from "./zaps";

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

export type Publish = (relays: string[], event: NostrEvent, options: PublishOptions) => Promise<PublishResult>;

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

// Relay URLs are chosen by the payer, so logging their host doesn't identify the receiving user.
function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
    let refusals: string | undefined;
    try {
      const result = await this.publishOne(job);
      if (result === true) return;
      refusals = result;
    } catch (err) {
      this.log.error("zap receipt failed:", err);
    }
    await this.recordFailure(job, refusals).catch((err) => this.log.error("could not record a failed zap receipt:", err));
  }

  /** True once a relay accepted the receipt; otherwise why each relay refused it. */
  private async publishOne(job: ZapReceiptJob): Promise<true | string> {
    if ("error" in job) throw job.error;
    const keys: NostrKeys = this.options.signer.keysFor(job.receiverIdentityPubkey);
    const receipt = buildZapReceipt(job, keys);
    const relays = receiptRelays(JSON.parse(job.zapRequest), this.options.policy);
    const { accepted, failures } = await this.publish(relays, receipt, { keys, policy: this.options.policy });
    if (accepted === 0) return failures.map(({ relay, reason }) => `${relayHost(relay)}: ${reason}`).join("; ") || "no relays";
    await this.options.store.zapReceiptPublished(job.paymentHash, JSON.stringify(receipt));
    return true;
  }

  /** `refusals` is set when every relay refused, and logged; a thrown failure was already logged. */
  private async recordFailure(job: ZapReceiptJob, refusals?: string): Promise<void> {
    const attempts = job.attempts + 1;
    const now = this.now();
    const giveUp = now - job.settledAt > this.giveUpAfterMs;
    if (giveUp) {
      this.log.warn(`giving up on a zap receipt not published after ${attempts} attempts${refusals ? ` (${refusals})` : ""}`);
    } else if (refusals) {
      const delayS = Math.round(retryDelay(attempts) / SECOND);
      this.log.warn(`zap receipt not accepted by any relay (attempt ${attempts}, retrying in ${delayS} s): ${refusals}`);
    }
    await this.options.store.zapReceiptFailed(job.paymentHash, attempts, giveUp ? null : now + retryDelay(attempts));
  }
}
