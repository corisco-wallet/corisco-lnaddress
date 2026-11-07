import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
  SPARK_WEBHOOK_PATH,
  receiveRequestIdCandidates,
  receiveRequestIdFrom,
  signBody,
  signatureMatches,
} from "../src/spark-webhook";
import { buildTestApp } from "./helpers";

const SECRET = "s".repeat(32);
const UUID = "0190f2a4-1c2d-7e3f-9a8b-123456789abc";
const receive = (id = UUID) => ({ id, request_status: "TRANSFER_COMPLETED", payment_preimage: "00".repeat(32) });

function setup(checkSoon = vi.fn(async (id: string) => id === `SparkLightningReceiveRequest:${UUID}`)) {
  const { app } = buildTestApp({ sparkWebhook: { secret: SECRET, checkSoon } });
  const post = (body: string, signature: string | null = signBody(body, SECRET)) =>
    app.request(SPARK_WEBHOOK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature ? { "x-spark-signature": signature } : {}) },
      body,
    });
  return { post, checkSoon };
}

describe("Spark webhook route", () => {
  it("brings the matching invoice's check forward", async () => {
    const { post, checkSoon } = setup();
    const res = await post(JSON.stringify({ event_type: "SPARK_LIGHTNING_RECEIVE_FINISHED", data: receive() }));
    expect(res.status).toBe(200);
    expect(checkSoon).toHaveBeenCalledWith(`SparkLightningReceiveRequest:${UUID}`);
    expect(checkSoon).toHaveBeenCalledTimes(1);
  });

  it("verifies the raw bytes, not a re-serialised body", async () => {
    const { post, checkSoon } = setup();
    const body = `{ "id" : "${UUID}",\n "request_status": "TRANSFER_COMPLETED" }`;
    expect((await post(body)).status).toBe(200);
    expect(checkSoon).toHaveBeenCalled();
  });

  it("rejects missing or wrong signatures without touching invoices", async () => {
    const { post, checkSoon } = setup();
    const body = JSON.stringify(receive());
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, signBody(body, "x".repeat(32)))).status).toBe(401);
    expect((await post(body + " ", signBody(body, SECRET))).status).toBe(401);
    expect(checkSoon).not.toHaveBeenCalled();
  });

  it("acknowledges events it doesn't act on", async () => {
    const { post, checkSoon } = setup();
    expect((await post(JSON.stringify({ event_type: "SPARK_LIGHTNING_SEND_FINISHED", data: receive() }))).status).toBe(200);
    expect((await post(JSON.stringify({ id: "event-1" }))).status).toBe(200);
    expect(checkSoon).not.toHaveBeenCalled();
  });

  it("asks Spark to retry when the invoice can't be updated", async () => {
    const { post } = setup(vi.fn(async () => Promise.reject(new Error("db down"))));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(JSON.stringify(receive()))).status).toBe(503);
  });

  it("refuses oversized bodies", async () => {
    const { post } = setup();
    expect((await post(JSON.stringify({ ...receive(), pad: "x".repeat(70_000) }))).status).toBe(413);
  });

  it("doesn't exist unless a webhook is configured", async () => {
    const { app } = buildTestApp();
    expect((await app.request(SPARK_WEBHOOK_PATH, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("Spark webhook helpers", () => {
  it("checks signatures", () => {
    const body = new TextEncoder().encode("{}");
    expect(signatureMatches(body, signBody(body, SECRET), SECRET)).toBe(true);
    expect(signatureMatches(body, signBody(body, SECRET).toUpperCase(), SECRET)).toBe(true);
    expect(signatureMatches(body, "zz", SECRET)).toBe(false);
  });

  it("finds the receive request, not an envelope id", () => {
    expect(receiveRequestIdFrom(receive())).toBe(UUID);
    expect(receiveRequestIdFrom({ id: "envelope", data: receive() })).toBe(UUID);
    expect(receiveRequestIdFrom({ id: "envelope", created_at: 1 })).toBeNull();
    expect(receiveRequestIdFrom([receive()])).toBeNull();
  });

  it("tries the SDK's prefixed id first", () => {
    expect(receiveRequestIdCandidates(UUID)).toEqual([`SparkLightningReceiveRequest:${UUID}`, UUID]);
    expect(receiveRequestIdCandidates(`SparkLightningReceiveRequest:${UUID}`)).toEqual([
      `SparkLightningReceiveRequest:${UUID}`,
      UUID,
    ]);
  });
});

describe("webhook config", () => {
  const base = {
    PUBLIC_BASE_URL: "https://pay.example.test",
    LNADDRESS_DOMAIN: "example.test",
    DB_HOST: "h",
    DB_USER: "u",
    DB_PASSWORD: "p",
    DB_NAME: "n",
    DATA_ENCRYPTION_KEY: "00".repeat(32),
    SERVER_MNEMONIC: "m",
  };

  it("is off without a secret and derives the URL from PUBLIC_BASE_URL", () => {
    expect(loadConfig(base).sparkWebhook).toBeUndefined();
    expect(loadConfig({ ...base, SPARK_WEBHOOK_SECRET: SECRET }).sparkWebhook).toEqual({
      url: "https://pay.example.test/webhooks/spark",
      secret: SECRET,
    });
  });

  it("needs a long secret and https", () => {
    expect(() => loadConfig({ ...base, SPARK_WEBHOOK_SECRET: "short" })).toThrow(/32/);
    expect(() =>
      loadConfig({ ...base, PUBLIC_BASE_URL: "http://localhost:3000", SPARK_WEBHOOK_SECRET: SECRET }),
    ).toThrow(/https/);
  });
});
