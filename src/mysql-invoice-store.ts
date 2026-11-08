import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { DataCipher } from "./crypto";
import type { Invoice, InvoiceStatus, InvoiceStore, NewInvoice, ZapReceiptJob } from "./invoice-store";

interface InvoiceRecord extends RowDataPacket {
  payment_hash: Buffer;
  receive_request_id: string;
  amount_msat: number | string;
  pr_enc: Buffer;
  preimage_enc: Buffer | null;
  status: InvoiceStatus;
  created_at: number | string;
  expires_at: number | string;
  settled_at: number | string | null;
}

interface ZapJobRecord extends RowDataPacket {
  payment_hash: Buffer;
  pr_enc: Buffer;
  preimage_enc: Buffer;
  settled_at: number | string;
  zap_request_enc: Buffer;
  zap_attempts: number;
  username_hash: Buffer;
  pubkey_hash: Buffer;
  pubkey_enc: Buffer;
}

const COLUMNS =
  "payment_hash, receive_request_id, amount_msat, pr_enc, preimage_enc, status, created_at, expires_at, settled_at";

const hashBytes = (paymentHash: string) => Buffer.from(paymentHash, "hex");

/** The invoice and preimage are encrypted with the payment hash as context, so a ciphertext can't be moved to another row. */
export class MysqlInvoiceStore implements InvoiceStore {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: DataCipher,
  ) {}

  async create(invoice: NewInvoice, firstCheckAt: number): Promise<void> {
    const hash = hashBytes(invoice.paymentHash);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO invoices (payment_hash, receive_request_id, user_id, amount_msat, pr_enc, created_at, expires_at, next_check_at,
                             zap_request_enc, zap_state, zap_next_attempt_at)
       SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM users WHERE username_hash = ?`,
      [
        hash,
        invoice.receiveRequestId,
        invoice.amountMsat,
        this.cipher.encrypt("invoice", invoice.pr, hash),
        invoice.createdAt,
        invoice.expiresAt,
        firstCheckAt,
        invoice.zapRequest === undefined ? null : this.cipher.encrypt("zap_request", invoice.zapRequest, hash),
        invoice.zapRequest === undefined ? null : "pending",
        invoice.zapRequest === undefined ? null : 0,
        this.cipher.lookupHash("username", invoice.username.toLowerCase()),
      ],
    );
    if (result.affectedRows !== 1) throw new Error("cannot store an invoice for an unknown user");
  }

  async get(paymentHash: string): Promise<Invoice | undefined> {
    const [rows] = await this.pool.execute<InvoiceRecord[]>(`SELECT ${COLUMNS} FROM invoices WHERE payment_hash = ?`, [
      hashBytes(paymentHash),
    ]);
    return rows[0] ? this.toInvoice(rows[0]) : undefined;
  }

  async getByReceiveRequestId(receiveRequestId: string): Promise<Invoice | undefined> {
    const [rows] = await this.pool.execute<InvoiceRecord[]>(
      `SELECT ${COLUMNS} FROM invoices WHERE receive_request_id = ?`,
      [receiveRequestId],
    );
    return rows[0] ? this.toInvoice(rows[0]) : undefined;
  }

  async due(now: number, limit: number): Promise<Invoice[]> {
    const [rows] = await this.pool.execute<InvoiceRecord[]>(
      `SELECT ${COLUMNS} FROM invoices WHERE status = 'pending' AND next_check_at <= ? ORDER BY next_check_at LIMIT ${Math.trunc(limit)}`,
      [now],
    );
    return rows.map((row) => this.toInvoice(row));
  }

  async reschedule(paymentHash: string, nextCheckAt: number): Promise<void> {
    await this.pool.execute("UPDATE invoices SET next_check_at = ? WHERE payment_hash = ? AND status = 'pending'", [
      nextCheckAt,
      hashBytes(paymentHash),
    ]);
  }

  async markSettled(paymentHash: string, preimage: string, settledAt: number): Promise<boolean> {
    const hash = hashBytes(paymentHash);
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE invoices SET status = 'settled', preimage_enc = ?, settled_at = ? WHERE payment_hash = ? AND status IN ('pending', 'expired')",
      [this.cipher.encrypt("preimage", preimage, hash), settledAt, hash],
    );
    return result.affectedRows === 1;
  }

  async markExpired(paymentHash: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE invoices SET status = 'expired' WHERE payment_hash = ? AND status = 'pending'",
      [hashBytes(paymentHash)],
    );
    return result.affectedRows === 1;
  }

  async deleteOld({ expiredBefore, settledBefore }: { expiredBefore: number; settledBefore: number }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM invoices
       WHERE (status = 'expired' AND expires_at < ?)
          OR (status = 'settled' AND settled_at < ? AND (zap_state IS NULL OR zap_state <> 'pending'))`,
      [expiredBefore, settledBefore],
    );
    return result.affectedRows;
  }

  async dueZapReceipts(now: number, limit: number): Promise<ZapReceiptJob[]> {
    const [rows] = await this.pool.execute<ZapJobRecord[]>(
      `SELECT i.payment_hash, i.pr_enc, i.preimage_enc, i.settled_at, i.zap_request_enc, i.zap_attempts,
              u.username_hash, u.pubkey_hash, u.pubkey_enc
       FROM invoices i JOIN users u ON u.id = i.user_id
       WHERE i.zap_state = 'pending' AND i.status = 'settled' AND i.zap_next_attempt_at <= ?
       ORDER BY i.zap_next_attempt_at LIMIT ${Math.trunc(limit)}`,
      [now],
    );
    return rows.map((row) => this.toZapReceiptJob(row));
  }

  private toZapReceiptJob(row: ZapJobRecord): ZapReceiptJob {
    const hash = Buffer.from(row.payment_hash);
    const base = { paymentHash: hash.toString("hex"), settledAt: Number(row.settled_at), attempts: row.zap_attempts };
    try {
      // Same context the user store seals the pubkey with, and the same consistency check it runs.
      const identityPubkey = this.cipher.decrypt("pubkey", row.pubkey_enc, Buffer.concat([row.username_hash, row.pubkey_hash]));
      if (!this.cipher.lookupHash("pubkey", identityPubkey).equals(row.pubkey_hash)) throw new Error("a stored user record failed verification");
      return {
        ...base,
        receiverIdentityPubkey: identityPubkey,
        zapRequest: this.cipher.decrypt("zap_request", Buffer.from(row.zap_request_enc), hash),
        pr: this.cipher.decrypt("invoice", Buffer.from(row.pr_enc), hash),
        preimage: this.cipher.decrypt("preimage", Buffer.from(row.preimage_enc), hash),
      };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async zapReceiptPublished(paymentHash: string, receipt: string): Promise<void> {
    const hash = hashBytes(paymentHash);
    await this.pool.execute(
      "UPDATE invoices SET zap_state = 'published', zap_receipt_enc = ?, zap_next_attempt_at = NULL WHERE payment_hash = ? AND zap_state = 'pending'",
      [this.cipher.encrypt("zap_receipt", receipt, hash), hash],
    );
  }

  async zapReceiptFailed(paymentHash: string, attempts: number, nextAttemptAt: number | null): Promise<void> {
    await this.pool.execute(
      `UPDATE invoices SET zap_attempts = ?, zap_next_attempt_at = ?, zap_state = IF(? IS NULL, 'abandoned', 'pending')
       WHERE payment_hash = ? AND zap_state = 'pending'`,
      [attempts, nextAttemptAt, nextAttemptAt, hashBytes(paymentHash)],
    );
  }

  private toInvoice(row: InvoiceRecord): Invoice {
    const hash = Buffer.from(row.payment_hash);
    return {
      paymentHash: hash.toString("hex"),
      receiveRequestId: row.receive_request_id,
      amountMsat: Number(row.amount_msat),
      pr: this.cipher.decrypt("invoice", Buffer.from(row.pr_enc), hash),
      status: row.status,
      preimage: row.preimage_enc ? this.cipher.decrypt("preimage", Buffer.from(row.preimage_enc), hash) : null,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      settledAt: row.settled_at === null ? null : Number(row.settled_at),
    };
  }
}
