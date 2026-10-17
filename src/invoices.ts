import { SparkWallet } from "@buildonspark/spark-sdk";
import type { Network } from "./config";

export interface InvoiceRequest {
  amountSats: number;
  descriptionHash: string;
  receiverIdentityPubkey: string;
  expirySeconds: number;
}

export interface InvoiceCreator {
  createInvoice(request: InvoiceRequest): Promise<string>;
}

/** The server wallet never holds funds; it only mints invoices whose receiver is the user's identity key. */
export async function createSparkInvoiceCreator(mnemonic: string, network: Network): Promise<InvoiceCreator> {
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  return {
    async createInvoice(request) {
      const result = await wallet.createLightningInvoice(request);
      return result.invoice.encodedInvoice;
    },
  };
}
