import { createHash } from "node:crypto";
import type { Invoice, InvoiceStore } from "./invoice-store";
import type { ReceiveStatus, ReceiveStatusSource } from "./invoices";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

export type CheckSchedule = (ageMs: number) => number;

/** Without webhooks: check often while a payer is most likely to pay, then back off. */
export const nextCheckDelay: CheckSchedule = (ageMs) => {
  if (ageMs < 2 * MINUTE) return 3 * SECOND;
  if (ageMs < 15 * MINUTE) return 15 * SECOND;
  return MINUTE;
};

/** With webhooks, polling only catches missed deliveries, so it can be much slower. */
export const backstopCheckDelay: CheckSchedule = (ageMs) => (ageMs < 2 * MINUTE ? 30 * SECOND : 2 * MINUTE);

export const FIRST_CHECK_DELAY_MS = nextCheckDelay(0);

export function preimageMatches(preimage: string, paymentHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(preimage)) return false;
  return createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") === paymentHash;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type SettledListener = (invoice: Invoice) => void | Promise<void>;

export interface SettlementOptions {
  store: InvoiceStore;
  source: ReceiveStatusSource;
  /** How long settled invoices are kept. */
  retentionDays: number;
  now?: () => number;
  log?: Pick<Console, "error" | "warn">;
  /** Invoices fetched per pass, and how many are checked at once. */
  batchSize?: number;
  concurrency?: number;
  /** A payment can land just after the invoice's expiry time; keep checking this long before giving up. */
  expiryGraceMs?: number;
  /** A status lookup that takes longer than this counts as failed. */
  lookupTimeoutMs?: number;
  /** Delay before re-checking an invoice whose status lookup failed. */
  retryDelayMs?: number;
  /** How long after expiry an invoice whose lookups keep failing is still retried before it is expired. */
  failedLookupCutoffMs?: number;
  /** How long expired, unpaid invoices are kept after their expiry time. */
  expiredRetentionMs?: number;
  schedule?: CheckSchedule;
}

/** Polls Spark for pending invoices until each is paid or expires; `checkSoon` lets a webhook bring a check forward. */
export class SettlementWatcher {
  private readonly listeners: SettledListener[] = [];
  private readonly now: () => number;
  private readonly log: Pick<Console, "error" | "warn">;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly expiryGraceMs: number;
  private readonly lookupTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly failedLookupCutoffMs: number;
  private readonly expiredRetentionMs: number;
  private readonly settledRetentionMs: number;
  private schedule: CheckSchedule;
  private timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly checking = new Set<string>();
  private readonly nudged = new Set<string>();
  private stopped = true;

  constructor(private readonly options: SettlementOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console;
    this.batchSize = options.batchSize ?? 50;
    this.concurrency = options.concurrency ?? 4;
    this.expiryGraceMs = options.expiryGraceMs ?? 2 * MINUTE;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? 15 * SECOND;
    this.retryDelayMs = options.retryDelayMs ?? 30 * SECOND;
    this.failedLookupCutoffMs = options.failedLookupCutoffMs ?? DAY;
    this.expiredRetentionMs = options.expiredRetentionMs ?? 10 * MINUTE;
    this.settledRetentionMs = options.retentionDays * DAY;
    this.schedule = options.schedule ?? nextCheckDelay;
  }

  get firstCheckDelayMs(): number {
    return this.schedule(0);
  }

  /** Applies to checks scheduled from now on. */
  useSchedule(schedule: CheckSchedule): void {
    this.schedule = schedule;
  }

  /**
   * Makes a pending invoice due now, or re-checks an expired one in case it was paid late; checks always verify
   * with Spark, so a forged call settles nothing. Returns false if no invoice has this receive request id.
   */
  async checkSoon(receiveRequestId: string): Promise<boolean> {
    const invoice = await this.options.store.getByReceiveRequestId(receiveRequestId);
    if (!invoice) return false;
    if (invoice.status === "pending") {
      if (this.checking.has(invoice.paymentHash)) this.nudged.add(invoice.paymentHash);
      await this.options.store.reschedule(invoice.paymentHash, this.now());
    } else if (invoice.status === "expired") {
      this.track(this.settleLate(invoice).catch((err) => this.log.error("late settlement check failed:", err)));
    }
    return true;
  }

  /** Called once per invoice, after it is stored as settled. */
  onSettled(listener: SettledListener): void {
    this.listeners.push(listener);
  }

  /** One pass over the invoices that are due for a check. */
  async poll(): Promise<void> {
    const due = await this.options.store.due(this.now(), this.batchSize);
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        await this.checkOnce(due[next++]).catch((err) => this.log.error("invoice check failed:", err));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, due.length) }, worker));
  }

  async purge(): Promise<number> {
    const now = this.now();
    return this.options.store.deleteOld({
      expiredBefore: now - this.expiredRetentionMs,
      settledBefore: now - this.settledRetentionMs,
    });
  }

  start({ pollEveryMs = 2 * SECOND, purgeEveryMs = 10 * MINUTE } = {}): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop(pollEveryMs, () => this.poll(), "settlement poll failed");
    this.loop(purgeEveryMs, () => this.purge(), "invoice purge failed");
  }

  /** Stops scheduling passes and waits for the current one to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    await Promise.all(this.inFlight);
  }

  private track(task: Promise<unknown>): void {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** Runs `task` every `everyMs`, never overlapping itself. */
  private loop(everyMs: number, task: () => Promise<unknown>, failure: string): void {
    const run = () => {
      if (this.stopped) return;
      const pass = task().catch((err) => this.log.error(`${failure}:`, err));
      this.inFlight.add(pass);
      void pass.then(() => {
        this.inFlight.delete(pass);
        if (this.stopped) return;
        const timer = setTimeout(() => {
          this.timers = this.timers.filter((t) => t !== timer);
          run();
        }, everyMs);
        this.timers.push(timer);
      });
    };
    run();
  }

  private async checkOnce(invoice: Invoice): Promise<void> {
    const hash = invoice.paymentHash;
    this.checking.add(hash);
    try {
      await this.check(invoice);
    } finally {
      this.checking.delete(hash);
      // A webhook that arrived mid-check had its reschedule overwritten by this check's.
      if (this.nudged.delete(hash)) await this.options.store.reschedule(hash, this.now());
    }
  }

  private lookup(invoice: Invoice): Promise<ReceiveStatus | null> {
    return withTimeout(this.options.source.getReceiveStatus(invoice.receiveRequestId), this.lookupTimeoutMs);
  }

  private async check(invoice: Invoice): Promise<void> {
    const { store } = this.options;
    let status;
    try {
      status = await this.lookup(invoice);
    } catch (err) {
      this.log.error("invoice status lookup failed:", err);
      const now = this.now();
      if (now > invoice.expiresAt + this.failedLookupCutoffMs) {
        this.log.warn("giving up on an invoice whose status lookups kept failing long after it expired");
        await store.markExpired(invoice.paymentHash);
      } else {
        await store.reschedule(invoice.paymentHash, now + this.retryDelayMs);
      }
      return;
    }
    const now = this.now();
    if (await this.settleIfPaid(invoice, status, now)) return;

    if (now > invoice.expiresAt + this.expiryGraceMs) {
      await store.markExpired(invoice.paymentHash);
    } else {
      await store.reschedule(invoice.paymentHash, now + this.schedule(now - invoice.createdAt));
    }
  }

  private async settleLate(invoice: Invoice): Promise<void> {
    await this.settleIfPaid(invoice, await this.lookup(invoice), this.now());
  }

  /** Returns true once the payment is proven, whether this call or an earlier one stored it. */
  private async settleIfPaid(invoice: Invoice, status: ReceiveStatus | null, now: number): Promise<boolean> {
    if (!status?.settled) return false;
    if (!status.preimage || !preimageMatches(status.preimage, invoice.paymentHash)) {
      // Never report a payment we can't prove: treat it as unpaid, so it keeps being checked until it expires.
      this.log.warn("Spark reports a settled invoice without a preimage matching its payment hash");
      return false;
    }
    if (await this.options.store.markSettled(invoice.paymentHash, status.preimage, now)) {
      await this.emit({ ...invoice, status: "settled", preimage: status.preimage, settledAt: now });
    }
    return true;
  }

  private async emit(invoice: Invoice): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(invoice);
      } catch (err) {
        this.log.error("invoice settled listener failed:", err);
      }
    }
  }
}
