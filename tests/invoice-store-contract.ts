import { beforeEach, describe, expect, it } from "vitest";
import type { UserStore } from "../src/db";
import type { InvoiceStore, NewInvoice } from "../src/invoice-store";

const PUBKEY = "02" + "ab".repeat(32);
const USERNAME = "payee-name-001";
export const HASH_A = "a1".repeat(32);
export const HASH_B = "b2".repeat(32);
export const HASH_C = "c3".repeat(32);
const PREIMAGE = "0f".repeat(32);

export const newInvoice = (overrides: Partial<NewInvoice> = {}): NewInvoice => ({
  paymentHash: HASH_A,
  receiveRequestId: `spark-request-${overrides.paymentHash ?? "a"}`,
  username: USERNAME,
  amountMsat: 21_000,
  pr: "lnbcrt210n1-test-invoice-a",
  createdAt: 1_000,
  expiresAt: 3_601_000,
  ...overrides,
});

/** Behaviour every InvoiceStore must have, whatever it stores the rows in. */
export function describeInvoiceStore(name: string, create: () => Promise<{ store: InvoiceStore; users: UserStore }>) {
  describe(`${name} invoice store`, () => {
    let store: InvoiceStore;

    beforeEach(async () => {
      let users: UserStore;
      ({ store, users } = await create());
      await users.getOrCreate(PUBKEY, () => USERNAME);
    });

    it("stores a pending invoice and reads it back", async () => {
      await store.create(newInvoice(), 4_000);
      expect(await store.get(HASH_A)).toEqual({
        paymentHash: HASH_A,
        receiveRequestId: "spark-request-a",
        amountMsat: 21_000,
        pr: "lnbcrt210n1-test-invoice-a",
        status: "pending",
        preimage: null,
        createdAt: 1_000,
        expiresAt: 3_601_000,
        settledAt: null,
      });
      expect(await store.get(HASH_B)).toBeUndefined();
    });

    it("finds the user case-insensitively and refuses unknown users", async () => {
      await store.create(newInvoice({ username: USERNAME.toUpperCase() }), 4_000);
      await expect(store.create(newInvoice({ paymentHash: HASH_B, username: "nobody-here-000" }), 4_000)).rejects.toThrow();
      expect(await store.get(HASH_B)).toBeUndefined();
    });

    it("refuses a payment hash it already has", async () => {
      await store.create(newInvoice(), 4_000);
      await expect(store.create(newInvoice({ pr: "another" }), 4_000)).rejects.toThrow();
      expect((await store.get(HASH_A))?.pr).toBe("lnbcrt210n1-test-invoice-a");
    });

    it("finds an invoice by its Spark receive request id", async () => {
      await store.create(newInvoice({ paymentHash: HASH_A, receiveRequestId: "spark-request-a" }), 4_000);
      await store.create(newInvoice({ paymentHash: HASH_B, receiveRequestId: "spark-request-b" }), 4_000);
      expect((await store.getByReceiveRequestId("spark-request-b"))?.paymentHash).toBe(HASH_B);
      expect(await store.getByReceiveRequestId("spark-request-z")).toBeUndefined();
    });

    it("refuses a receive request id it already has", async () => {
      await store.create(newInvoice({ paymentHash: HASH_A, receiveRequestId: "spark-request-a" }), 4_000);
      await expect(store.create(newInvoice({ paymentHash: HASH_B, receiveRequestId: "spark-request-a" }), 4_000)).rejects.toThrow();
      expect(await store.get(HASH_B)).toBeUndefined();
    });

    it("lists due pending invoices, earliest check first, up to the limit", async () => {
      await store.create(newInvoice({ paymentHash: HASH_A }), 5_000);
      await store.create(newInvoice({ paymentHash: HASH_B }), 3_000);
      await store.create(newInvoice({ paymentHash: HASH_C }), 9_000);
      expect((await store.due(6_000, 10)).map((i) => i.paymentHash)).toEqual([HASH_B, HASH_A]);
      expect((await store.due(6_000, 1)).map((i) => i.paymentHash)).toEqual([HASH_B]);

      await store.reschedule(HASH_B, 7_000);
      expect((await store.due(6_000, 10)).map((i) => i.paymentHash)).toEqual([HASH_A]);

      await store.markExpired(HASH_A);
      expect(await store.due(10_000, 10)).toHaveLength(2);
    });

    it("settles a pending invoice once", async () => {
      await store.create(newInvoice(), 4_000);
      expect(await store.markSettled(HASH_A, PREIMAGE, 50_000)).toBe(true);
      expect(await store.markSettled(HASH_A, "1f".repeat(32), 60_000)).toBe(false);
      expect(await store.markExpired(HASH_A)).toBe(false);
      expect(await store.get(HASH_A)).toMatchObject({ status: "settled", preimage: PREIMAGE, settledAt: 50_000 });
      expect(await store.due(100_000, 10)).toHaveLength(0);
    });

    it("settles an expired invoice paid late, but only once", async () => {
      await store.create(newInvoice(), 4_000);
      expect(await store.markExpired(HASH_A)).toBe(true);
      expect(await store.markSettled(HASH_A, PREIMAGE, 50_000)).toBe(true);
      expect(await store.markSettled(HASH_A, PREIMAGE, 60_000)).toBe(false);
      expect(await store.markExpired(HASH_A)).toBe(false);
      expect(await store.get(HASH_A)).toMatchObject({ status: "settled", preimage: PREIMAGE, settledAt: 50_000 });
    });

    it("deletes old expired and settled rows but never pending ones", async () => {
      await store.create(newInvoice({ paymentHash: HASH_A, expiresAt: 10_000 }), 4_000);
      await store.create(newInvoice({ paymentHash: HASH_B, expiresAt: 10_000 }), 4_000);
      await store.create(newInvoice({ paymentHash: HASH_C, expiresAt: 10_000 }), 4_000);
      await store.markExpired(HASH_A);
      await store.markSettled(HASH_B, PREIMAGE, 20_000);

      expect(await store.deleteOld({ expiredBefore: 10_000, settledBefore: 20_000 })).toBe(0);
      expect(await store.deleteOld({ expiredBefore: 10_001, settledBefore: 20_000 })).toBe(1);
      expect(await store.get(HASH_A)).toBeUndefined();
      expect(await store.deleteOld({ expiredBefore: 1e12, settledBefore: 20_001 })).toBe(1);
      expect(await store.get(HASH_B)).toBeUndefined();
      expect((await store.get(HASH_C))?.status).toBe("pending");
    });
  });
}
