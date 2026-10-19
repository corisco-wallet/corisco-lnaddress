import { Hono } from "hono";
import { cors } from "hono/cors";
import { isValidPubkey, verifyRegistrationSignature } from "./auth";
import type { ChallengeStore } from "./challenge";
import type { Config } from "./config";
import type { UserStore } from "./db";
import type { InvoiceCreator } from "./invoices";
import { INVOICE_EXPIRY_SECONDS, MIN_SENDABLE_SATS, buildMetadata, descriptionHash, parseAmountMsats } from "./lnurl";

export interface Deps {
  config: Config;
  users: UserStore;
  challenges: ChallengeStore;
  invoices: InvoiceCreator;
}

const lnurlError = (reason: string) => ({ status: "ERROR", reason });

export function createApp({ config, users, challenges, invoices }: Deps): Hono {
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
    });
  });

  app.get("/lnurl/callback/:username", async (c) => {
    const user = await users.getByUsername(c.req.param("username"));
    if (!user?.active) return c.json(lnurlError("unknown user"));
    const amount = parseAmountMsats(c.req.query("amount"), config.maxSendableSats);
    if ("error" in amount) return c.json(lnurlError(amount.error));
    try {
      const pr = await invoices.createInvoice({
        amountSats: amount.sats,
        descriptionHash: descriptionHash(buildMetadata(user.username, config.domain)),
        receiverIdentityPubkey: user.identityPubkey,
        expirySeconds: INVOICE_EXPIRY_SECONDS,
      });
      return c.json({ pr, successAction: null, disposable: false, routes: [] });
    } catch (err) {
      console.error("invoice creation failed:", err);
      return c.json(lnurlError("could not create invoice"));
    }
  });

  return app;
}
