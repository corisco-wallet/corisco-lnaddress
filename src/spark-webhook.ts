import { createHmac, timingSafeEqual } from "node:crypto";

export const SPARK_WEBHOOK_PATH = "/webhooks/spark";
export const RECEIVE_FINISHED = "SPARK_LIGHTNING_RECEIVE_FINISHED";
/** Spark payloads are small; anything much bigger isn't from Spark. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** The SDK prefixes receive request ids with their type; webhooks send the bare UUID. */
const RECEIVE_REQUEST_PREFIX = "SparkLightningReceiveRequest:";

/** `X-Spark-Signature` is the hex HMAC-SHA256 of the raw body, keyed with the registered secret. */
export function signatureMatches(rawBody: Uint8Array, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.trim(), "hex"));
}

export function signBody(rawBody: Uint8Array | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Fields only a Lightning receive request has, so its `id` isn't confused with an envelope's own id. */
const RECEIVE_FIELDS = ["request_status", "payment_preimage", "receiver_identity_public_key", "invoice_amount", "htlc_amount"];

// Spark documents the receive request's fields but not its envelope, so accept it top-level or under a wrapper key.
export function receiveRequestIdFrom(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const eventType = payload.event_type ?? payload.type;
  if (typeof eventType === "string" && eventType !== RECEIVE_FINISHED) return null;
  for (const candidate of [payload, payload.data, payload.object, payload.entity, payload.payload]) {
    if (!isObject(candidate) || typeof candidate.id !== "string" || !candidate.id) continue;
    if (RECEIVE_FIELDS.some((field) => field in candidate)) return candidate.id;
  }
  return null;
}

/** The SDK's prefixed form comes first, since that's what is stored. */
export function receiveRequestIdCandidates(id: string): string[] {
  if (id.startsWith(RECEIVE_REQUEST_PREFIX)) return [id, id.slice(RECEIVE_REQUEST_PREFIX.length)];
  return [RECEIVE_REQUEST_PREFIX + id, id];
}
