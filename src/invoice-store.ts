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
  /** The kind-9734 JSON, exactly as received; set when the invoice pays a zap. */
  zapRequest?: string;
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

interface ZapReceiptJobBase {
  paymentHash: string;
  settledAt: number;
  attempts: number;
}

/** A settled zap whose receipt hasn't been published yet. */
export interface ReadableZapReceiptJob extends ZapReceiptJobBase {
  receiverIdentityPubkey: string;
  zapRequest: string;
  pr: string;
  preimage: string;
}

/** A pending receipt whose row failed decryption or verification; it is retried and given up on like a failed publish. */
export interface UnreadableZapReceiptJob extends ZapReceiptJobBase {
  error: Error;
}

export type ZapReceiptJob = ReadableZapReceiptJob | UnreadableZapReceiptJob;

export interface InvoiceStore {
  /** Fails if the user doesn't exist or the payment hash or receive request id is already stored. */
  create(invoice: NewInvoice, firstCheckAt: number): Promise<void>;
  get(paymentHash: string): Promise<Invoice | undefined>;
  getByReceiveRequestId(receiveRequestId: string): Promise<Invoice | undefined>;
  /** Pending invoices whose next status check is due, earliest first. */
  due(now: number, limit: number): Promise<Invoice[]>;
  reschedule(paymentHash: string, nextCheckAt: number): Promise<void>;
  /** Moves a pending or expired invoice (a proven late payment); returns false otherwise. The caller checks the preimage. */
  markSettled(paymentHash: string, preimage: string, settledAt: number): Promise<boolean>;
  /** Only moves a pending invoice; returns false if it wasn't pending. */
  markExpired(paymentHash: string): Promise<boolean>;
  /** Deletes expired rows that expired before `expiredBefore` and settled rows settled before `settledBefore`, keeping zaps whose receipt is still pending. */
  deleteOld(cutoffs: { expiredBefore: number; settledBefore: number }): Promise<number>;
  /** Settled zaps with a pending receipt whose next attempt is due, earliest first. */
  dueZapReceipts(now: number, limit: number): Promise<ZapReceiptJob[]>;
  zapReceiptPublished(paymentHash: string, receipt: string): Promise<void>;
  /** Records a failed attempt; `nextAttemptAt` null gives up on the receipt. */
  zapReceiptFailed(paymentHash: string, attempts: number, nextAttemptAt: number | null): Promise<void>;
}
