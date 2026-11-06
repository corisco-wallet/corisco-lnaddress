import type { UserStore } from "../src/db";
import type { Invoice, InvoiceStore, NewInvoice } from "../src/invoice-store";

export class MemoryInvoiceStore implements InvoiceStore {
  private readonly rows = new Map<string, { invoice: Invoice; nextCheckAt: number }>();

  constructor(private readonly users: UserStore) {}

  async create(invoice: NewInvoice, firstCheckAt: number) {
    if (!(await this.users.getByUsername(invoice.username))) throw new Error("cannot store an invoice for an unknown user");
    if (this.rows.has(invoice.paymentHash)) throw new Error("duplicate payment hash");
    const { username: _username, ...rest } = invoice;
    this.rows.set(invoice.paymentHash, {
      invoice: { ...rest, status: "pending", preimage: null, settledAt: null },
      nextCheckAt: firstCheckAt,
    });
  }

  async get(paymentHash: string) {
    const row = this.rows.get(paymentHash);
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
    if (row?.invoice.status !== "pending") return false;
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
    for (const [hash, { invoice }] of this.rows) {
      const old =
        (invoice.status === "expired" && invoice.expiresAt < expiredBefore) ||
        (invoice.status === "settled" && invoice.settledAt! < settledBefore);
      if (old && this.rows.delete(hash)) deleted++;
    }
    return deleted;
  }
}
