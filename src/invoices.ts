import { SparkWallet } from "@buildonspark/spark-sdk";
import type { Network } from "./config";

export interface InvoiceRequest {
  amountSats: number;
  descriptionHash: string;
  receiverIdentityPubkey: string;
  expirySeconds: number;
}

export interface CreatedInvoice {
  /** BOLT11 invoice returned to the payer. */
  pr: string;
  /** Hex, 32 bytes. */
  paymentHash: string;
  /** Spark's id for the receive request, used to ask whether it was paid. */
  receiveRequestId: string;
  /** Unix ms. */
  expiresAt: number;
}

export interface InvoiceCreator {
  createInvoice(request: InvoiceRequest): Promise<CreatedInvoice>;
}

export interface ReceiveStatus {
  settled: boolean;
  /** Hex; only meaningful once settled. */
  preimage: string | null;
}

export interface ReceiveStatusSource {
  /** `null` when Spark doesn't know the request. */
  getReceiveStatus(receiveRequestId: string): Promise<ReceiveStatus | null>;
}

/**
 * Spark statuses that mean the Lightning payment reached the receiver. Everything else, including
 * statuses added later (FUTURE_VALUE), counts as not paid yet; an invoice that never gets here expires.
 */
const SETTLED_STATUSES = new Set(["LIGHTNING_PAYMENT_RECEIVED", "TRANSFER_CREATED", "TRANSFER_COMPLETED"]);

export function isSettledStatus(status: string): boolean {
  return SETTLED_STATUSES.has(status);
}

/** The server wallet never holds funds; it only mints invoices whose receiver is the user's identity key. */
export async function createSparkLightning(
  mnemonic: string,
  network: Network,
): Promise<InvoiceCreator & ReceiveStatusSource> {
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  return {
    async createInvoice(request) {
      const result = await wallet.createLightningInvoice(request);
      const expiresAt = Date.parse(result.invoice.expiresAt);
      return {
        pr: result.invoice.encodedInvoice,
        paymentHash: result.invoice.paymentHash.toLowerCase(),
        receiveRequestId: result.id,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + request.expirySeconds * 1000,
      };
    },

    async getReceiveStatus(receiveRequestId) {
      const request = await wallet.getLightningReceiveRequest(receiveRequestId);
      if (!request) return null;
      return { settled: isSettledStatus(request.status), preimage: request.paymentPreimage?.toLowerCase() ?? null };
    },
  };
}
