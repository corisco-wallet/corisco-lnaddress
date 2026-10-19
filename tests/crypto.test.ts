import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDataCipher, parseDataKey } from "../src/crypto";

const cipher = createDataCipher(Buffer.alloc(32, 7));
const context = Buffer.alloc(64, 1);
const PUBKEY = "02" + "ab".repeat(32);

describe("parseDataKey", () => {
  it("accepts 64 hex characters", () => {
    expect(parseDataKey("ab".repeat(32))).toHaveLength(32);
  });

  it.each([[""], ["ab".repeat(31)], ["zz".repeat(32)], ["ab".repeat(33)]])("rejects %j", (value) => {
    expect(() => parseDataKey(value)).toThrow("DATA_ENCRYPTION_KEY");
  });
});

describe("lookupHash", () => {
  it("is stable, keyed and separated by field", () => {
    expect(cipher.lookupHash("username", "alice")).toEqual(cipher.lookupHash("username", "alice"));
    expect(cipher.lookupHash("username", "alice")).not.toEqual(cipher.lookupHash("username", "bob"));
    expect(cipher.lookupHash("username", "alice")).not.toEqual(cipher.lookupHash("pubkey", "alice"));
    expect(createDataCipher(Buffer.alloc(32, 8)).lookupHash("username", "alice")).not.toEqual(cipher.lookupHash("username", "alice"));
    expect(cipher.lookupHash("username", "alice")).toHaveLength(32);
  });
});

describe("encrypt and decrypt", () => {
  it("round-trips a value", () => {
    const sealed = cipher.encrypt("pubkey", PUBKEY, context);
    expect(cipher.decrypt("pubkey", sealed, context)).toBe(PUBKEY);
  });

  it("never stores the plaintext and uses a fresh nonce each time", () => {
    const a = cipher.encrypt("pubkey", PUBKEY, context);
    const b = cipher.encrypt("pubkey", PUBKEY, context);
    expect(a.includes(Buffer.from(PUBKEY))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("refuses a different key", () => {
    const sealed = cipher.encrypt("pubkey", PUBKEY, context);
    expect(() => createDataCipher(randomBytes(32)).decrypt("pubkey", sealed, context)).toThrow();
  });

  it("refuses a changed ciphertext, nonce, tag or version", () => {
    const sealed = cipher.encrypt("pubkey", PUBKEY, context);
    for (const index of [0, 1, 13, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[index] ^= 1;
      expect(() => cipher.decrypt("pubkey", copy, context)).toThrow();
    }
    expect(() => cipher.decrypt("pubkey", sealed.subarray(0, 10), context)).toThrow("unrecognised");
  });

  it("only decrypts in the row and field it was written for", () => {
    const sealed = cipher.encrypt("pubkey", PUBKEY, context);
    expect(() => cipher.decrypt("pubkey", sealed, Buffer.alloc(64, 2))).toThrow();
    expect(() => cipher.decrypt("username", sealed, context)).toThrow();
  });
});
