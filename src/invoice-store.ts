export type InvoiceStatus = "pending" | "settled" | "expired";

export interface NewInvoice {
  /** Hex, 32 bytes. */
  paymentHash: string;
  receiveRequestId: string;
  /** The receiving user; stores link the row to that user without copying their pubkey. */
  username: string;
  amountMsat: number;
  pr: string;
  /** Unix ms, for this and every other timestamp here. */
  createdAt: number;
  expiresAt: number;
}

export interface Invoice {
  paymentHash: string;
  receiveRequestId: string;
  amountMsat: number;
  pr: string;
  status: InvoiceStatus;
  /** Hex; set only once settled. */
  preimage: string | null;
  createdAt: number;
  expiresAt: number;
  settledAt: number | null;
}

export interface InvoiceStore {
  /** Fails if the user doesn't exist or the payment hash or receive request id is already stored. */
  create(invoice: NewInvoice, firstCheckAt: number): Promise<void>;
  get(paymentHash: string): Promise<Invoice | undefined>;
  getByReceiveRequestId(receiveRequestId: string): Promise<Invoice | undefined>;
  /** Pending invoices whose next status check is due, earliest first. */
  due(now: number, limit: number): Promise<Invoice[]>;
  reschedule(paymentHash: string, nextCheckAt: number): Promise<void>;
  /** Only moves a pending invoice; returns false if it wasn't pending. The caller checks the preimage against the hash. */
  markSettled(paymentHash: string, preimage: string, settledAt: number): Promise<boolean>;
  /** Only moves a pending invoice; returns false if it wasn't pending. */
  markExpired(paymentHash: string): Promise<boolean>;
  /** Deletes expired rows that expired before `expiredBefore` and settled rows settled before `settledBefore`. */
  deleteOld(cutoffs: { expiredBefore: number; settledBefore: number }): Promise<number>;
}
