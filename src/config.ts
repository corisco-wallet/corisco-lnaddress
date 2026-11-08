import { parseDataKey } from "./crypto";
import { SPARK_WEBHOOK_PATH } from "./spark-webhook";

export type Network = "REGTEST" | "MAINNET";

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
}

export interface Config {
  port: number;
  network: Network;
  domain: string;
  publicBaseUrl: string;
  database: DatabaseConfig;
  dataKey: Buffer;
  serverMnemonic: string;
  maxSendableSats: number;
  /** How long paid invoices are kept, for payment status lookups. */
  invoiceRetentionDays: number;
  sparkWebhook?: { url: string; secret: string };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = env.SPARK_NETWORK ?? "REGTEST";
  if (network !== "REGTEST" && network !== "MAINNET") {
    throw new Error(`SPARK_NETWORK must be REGTEST or MAINNET, got "${network}"`);
  }
  const publicBaseUrl = required(env, "PUBLIC_BASE_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(publicBaseUrl)) throw new Error("PUBLIC_BASE_URL must start with http:// or https://");
  if (network === "MAINNET" && !publicBaseUrl.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must be https on MAINNET");
  }
  const port = Number(env.PORT ?? 3000);
  const maxSendableSats = Number(env.MAX_SENDABLE_SATS ?? 1_000_000);
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
  if (!Number.isInteger(maxSendableSats) || maxSendableSats < 1) throw new Error("MAX_SENDABLE_SATS must be a positive integer");
  const invoiceRetentionDays = Number(env.INVOICE_RETENTION_DAYS?.trim() || 7);
  if (!Number.isInteger(invoiceRetentionDays) || invoiceRetentionDays < 1) {
    throw new Error("INVOICE_RETENTION_DAYS must be a positive integer");
  }
  const webhookSecret = env.SPARK_WEBHOOK_SECRET?.trim();
  if (webhookSecret) {
    if (webhookSecret.length < 32) throw new Error("SPARK_WEBHOOK_SECRET must be at least 32 characters");
    if (!publicBaseUrl.startsWith("https://")) throw new Error("SPARK_WEBHOOK_SECRET needs an https PUBLIC_BASE_URL");
  }
  return {
    port,
    network,
    domain: required(env, "LNADDRESS_DOMAIN").toLowerCase(),
    publicBaseUrl,
    database: {
      host: required(env, "DB_HOST"),
      port: Number(env.DB_PORT ?? 3306),
      user: required(env, "DB_USER"),
      password: required(env, "DB_PASSWORD"),
      name: required(env, "DB_NAME"),
    },
    dataKey: parseDataKey(required(env, "DATA_ENCRYPTION_KEY")),
    serverMnemonic: required(env, "SERVER_MNEMONIC"),
    maxSendableSats,
    invoiceRetentionDays,
    sparkWebhook: webhookSecret ? { url: publicBaseUrl + SPARK_WEBHOOK_PATH, secret: webhookSecret } : undefined,
  };
}
