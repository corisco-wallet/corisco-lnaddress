import type { UserStore } from "../src/db";
import type { Invoice, InvoiceStore, NewInvoice, ZapReceiptJob } from "../src/invoice-store";

interface ZapRow {
  request: string;
  state: "pending" | "published" | "abandoned";
  attempts: number;
  nextAttemptAt: number | null;
  receipt: string | null;
}

export class MemoryInvoiceStore implements InvoiceStore {
  private readonly rows = new Map<string, { invoice: Invoice; nextCheckAt: number; receiver: string; zap: ZapRow | null }>();

  constructor(private readonly users: UserStore) {}

  async create(invoice: NewInvoice, firstCheckAt: number) {
    const user = await this.users.getByUsername(invoice.username);
    if (!user) throw new Error("cannot store an invoice for an unknown user");
    if (this.rows.has(invoice.paymentHash)) throw new Error("duplicate payment hash");
    if (await this.getByReceiveRequestId(invoice.receiveRequestId)) throw new Error("duplicate receive request id");
    const { username: _username, zapRequest, ...rest } = invoice;
    this.rows.set(invoice.paymentHash, {
      invoice: { ...rest, status: "pending", preimage: null, settledAt: null },
      nextCheckAt: firstCheckAt,
      receiver: user.identityPubkey,
      zap: zapRequest === undefined ? null : { request: zapRequest, state: "pending", attempts: 0, nextAttemptAt: 0, receipt: null },
    });
  }

  async get(paymentHash: string) {
    const row = this.rows.get(paymentHash);
    return row && { ...row.invoice };
  }

  async getByReceiveRequestId(receiveRequestId: string) {
    const row = [...this.rows.values()].find((r) => r.invoice.receiveRequestId === receiveRequestId);
    return row && { ...row.invoice };
  }

  async due(now: number, limit: number) {
    return [...this.rows.values()]
      .filter((row) => row.invoice.status === "pending" && row.nextCheckAt <= now)
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
      .slice(0, limit)
      .map((row) => ({ ...row.invoice }));
  }

  async reschedule(paymentHash: string, nextCheckAt: number) {
    const row = this.rows.get(paymentHash);
    if (row?.invoice.status === "pending") row.nextCheckAt = nextCheckAt;
  }

  async markSettled(paymentHash: string, preimage: string, settledAt: number) {
    const row = this.rows.get(paymentHash);
    if (row?.invoice.status !== "pending" && row?.invoice.status !== "expired") return false;
    Object.assign(row.invoice, { status: "settled", preimage, settledAt });
    return true;
  }

  async markExpired(paymentHash: string) {
    const row = this.rows.get(paymentHash);
    if (row?.invoice.status !== "pending") return false;
    row.invoice.status = "expired";
    return true;
  }

  async deleteOld({ expiredBefore, settledBefore }: { expiredBefore: number; settledBefore: number }) {
    let deleted = 0;
    for (const [hash, { invoice, zap }] of this.rows) {
      const old =
        (invoice.status === "expired" && invoice.expiresAt < expiredBefore) ||
        (invoice.status === "settled" && invoice.settledAt! < settledBefore && zap?.state !== "pending");
      if (old && this.rows.delete(hash)) deleted++;
    }
    return deleted;
  }

  async dueZapReceipts(now: number, limit: number): Promise<ZapReceiptJob[]> {
    return [...this.rows.values()]
      .filter(({ invoice, zap }) => invoice.status === "settled" && zap?.state === "pending" && zap.nextAttemptAt! <= now)
      .sort((a, b) => a.zap!.nextAttemptAt! - b.zap!.nextAttemptAt!)
      .slice(0, limit)
      .map(({ invoice, receiver, zap }) => ({
        paymentHash: invoice.paymentHash,
        receiverIdentityPubkey: receiver,
        zapRequest: zap!.request,
        pr: invoice.pr,
        preimage: invoice.preimage!,
        settledAt: invoice.settledAt!,
        attempts: zap!.attempts,
      }));
  }

  async zapReceiptPublished(paymentHash: string, receipt: string) {
    const zap = this.rows.get(paymentHash)?.zap;
    if (zap?.state === "pending") Object.assign(zap, { state: "published", receipt, nextAttemptAt: null });
  }

  async zapReceiptFailed(paymentHash: string, attempts: number, nextAttemptAt: number | null) {
    const zap = this.rows.get(paymentHash)?.zap;
    if (zap?.state === "pending") Object.assign(zap, { attempts, nextAttemptAt, state: nextAttemptAt === null ? "abandoned" : "pending" });
  }

  /** Test helper: the stored zap state for an invoice. */
  zapOf(paymentHash: string): ZapRow | null | undefined {
    const zap = this.rows.get(paymentHash)?.zap;
    return zap && { ...zap };
  }
}
