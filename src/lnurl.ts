import { createHash } from "node:crypto";

export const MIN_SENDABLE_SATS = 1;
export const INVOICE_EXPIRY_SECONDS = 3600;

export function buildMetadata(username: string, domain: string): string {
  return JSON.stringify([
    ["text/plain", `Payment to ${username}@${domain}`],
    ["text/identifier", `${username}@${domain}`],
  ]);
}

export function descriptionHash(metadata: string): string {
  return createHash("sha256").update(metadata).digest("hex");
}

export function parseAmountMsats(raw: string | undefined, maxSendableSats: number): { sats: number } | { error: string } {
  if (!raw || !/^\d+$/.test(raw)) return { error: "amount must be a positive integer in millisatoshis" };
  const msats = BigInt(raw);
  if (msats % 1000n !== 0n) return { error: "amount must be a whole number of satoshis" };
  const sats = msats / 1000n;
  if (sats < BigInt(MIN_SENDABLE_SATS) || sats > BigInt(maxSendableSats)) {
    return { error: `amount must be between ${MIN_SENDABLE_SATS} and ${maxSendableSats} sats` };
  }
  return { sats: Number(sats) };
}
