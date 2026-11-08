import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { isValidPubkey, verifyRegistrationSignature } from "./auth";
import type { ChallengeStore } from "./challenge";
import type { Config } from "./config";
import type { UserStore } from "./db";
import type { InvoiceStore } from "./invoice-store";
import type { InvoiceCreator } from "./invoices";
import { FIRST_CHECK_DELAY_MS } from "./settlement";
import {
  MAX_WEBHOOK_BODY_BYTES,
  SPARK_WEBHOOK_PATH,
  receiveRequestIdCandidates,
  receiveRequestIdFrom,
  signatureMatches,
} from "./spark-webhook";
import { INVOICE_EXPIRY_SECONDS, MIN_SENDABLE_SATS, buildMetadata, descriptionHash, parseAmountMsats } from "./lnurl";
import { type RelayPolicy, type ZapSigner, validateZapRequest } from "./zaps";

export interface Deps {
  config: Config;
  users: UserStore;
  challenges: ChallengeStore;
  invoices: InvoiceCreator;
  invoiceStore: InvoiceStore;
  /** Must match the settlement watcher's current schedule. */
  firstCheckDelayMs?: () => number;
  sparkWebhook?: SparkWebhookDeps;
  zaps?: { signer: ZapSigner; policy: RelayPolicy };
  now?: () => number;
}

export interface SparkWebhookDeps {
  secret: string;
  /** Returns false if no invoice has this receive request id. */
  checkSoon(receiveRequestId: string): Promise<boolean>;
}

const lnurlError = (reason: string) => ({ status: "ERROR", reason });

export function createApp({
  config,
  users,
  challenges,
  invoices,
  invoiceStore,
  firstCheckDelayMs = () => FIRST_CHECK_DELAY_MS,
  sparkWebhook,
  zaps,
  now = Date.now,
}: Deps): Hono {
  const app = new Hono();

  app.use("/.well-known/lnurlp/*", cors());
  app.use("/lnurl/*", cors());

  app.get("/challenge", (c) => {
    try {
      return c.json(challenges.issue());
    } catch {
      return c.json({ error: "try again later" }, 503);
    }
  });

  app.post("/users", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { identityPubkey, nonce, signature } = (body ?? {}) as Record<string, unknown>;
    if (typeof identityPubkey !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
      return c.json({ error: "identityPubkey, nonce and signature are required" }, 400);
    }
    const pubkey = identityPubkey.toLowerCase();
    if (!isValidPubkey(pubkey)) return c.json({ error: "invalid identityPubkey" }, 400);
    if (!challenges.consume(nonce)) return c.json({ error: "unknown or expired nonce" }, 401);
    if (!verifyRegistrationSignature(pubkey, nonce, config.domain, signature)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    const user = await users.getOrCreate(pubkey);
    return c.json({ username: user.username, address: `${user.username}@${config.domain}` });
  });

  app.get("/.well-known/lnurlp/:username", async (c) => {
    const user = await users.getByUsername(c.req.param("username"));
    if (!user?.active) return c.json(lnurlError("unknown user"));
    return c.json({
      tag: "payRequest",
      callback: `${config.publicBaseUrl}/lnurl/callback/${user.username}`,
      minSendable: MIN_SENDABLE_SATS * 1000,
      maxSendable: config.maxSendableSats * 1000,
      metadata: buildMetadata(user.username, config.domain),
      ...(zaps && { allowsNostr: true, nostrPubkey: zaps.signer.keysFor(user.identityPubkey).pubkey }),
    });
  });

  app.get("/lnurl/callback/:username", async (c) => {
    const user = await users.getByUsername(c.req.param("username"));
    if (!user?.active) return c.json(lnurlError("unknown user"));
    const amount = parseAmountMsats(c.req.query("amount"), config.maxSendableSats);
    if ("error" in amount) return c.json(lnurlError(amount.error));
    const zapRequest = c.req.query("nostr");
    if (zapRequest !== undefined) {
      if (!zaps) return c.json(lnurlError("nostr zaps are not supported"));
      const receiptPubkey = zaps.signer.keysFor(user.identityPubkey).pubkey;
      const zap = validateZapRequest(zapRequest, amount.sats * 1000, receiptPubkey, zaps.policy);
      if ("error" in zap) return c.json(lnurlError(zap.error));
    }
    try {
      const invoice = await invoices.createInvoice({
        amountSats: amount.sats,
        // A zap invoice commits to the zap request itself (NIP-57), not to the LNURL metadata.
        descriptionHash: descriptionHash(zapRequest ?? buildMetadata(user.username, config.domain)),
        receiverIdentityPubkey: user.identityPubkey,
        expirySeconds: INVOICE_EXPIRY_SECONDS,
      });
      // Only hand out invoices we can track; one that fails to store is never shown to the payer.
      const createdAt = now();
      await invoiceStore.create(
        {
          paymentHash: invoice.paymentHash,
          receiveRequestId: invoice.receiveRequestId,
          username: user.username,
          amountMsat: amount.sats * 1000,
          pr: invoice.pr,
          createdAt,
          expiresAt: invoice.expiresAt,
          zapRequest,
        },
        createdAt + firstCheckDelayMs(),
      );
      return c.json({ pr: invoice.pr, successAction: null, disposable: false, routes: [] });
    } catch (err) {
      console.error("invoice creation failed:", err);
      return c.json(lnurlError("could not create invoice"));
    }
  });

  if (sparkWebhook) {
    app.post(
      SPARK_WEBHOOK_PATH,
      bodyLimit({ maxSize: MAX_WEBHOOK_BODY_BYTES, onError: (c) => c.json({ error: "payload too large" }, 413) }),
      async (c) => {
        // Verify the exact bytes Spark signed, before parsing.
        const raw = new Uint8Array(await c.req.arrayBuffer());
        if (!signatureMatches(raw, c.req.header("x-spark-signature"), sparkWebhook.secret)) {
          return c.json({ error: "invalid signature" }, 401);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return c.json({ error: "invalid json" }, 400);
        }
        const id = receiveRequestIdFrom(payload);
        if (!id) {
          // Acknowledge, so Spark doesn't retry something we'll never understand; polling still covers it.
          const keys = payload && typeof payload === "object" ? Object.keys(payload).join(",") : typeof payload;
          console.warn(`ignoring a Spark webhook without a receive request (keys: ${keys})`);
          return c.json({ ok: true });
        }
        try {
          let known = false;
          for (const candidate of receiveRequestIdCandidates(id)) {
            if ((known = await sparkWebhook.checkSoon(candidate))) break;
          }
          if (!known) console.warn(`ignoring a Spark webhook for an unknown receive request: ${id}`);
        } catch (err) {
          console.error("spark webhook handling failed:", err);
          return c.json({ error: "try again later" }, 503);
        }
        return c.json({ ok: true });
      },
    );
  }

  return app;
}
