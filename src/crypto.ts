import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = Buffer.from("corisco-lnaddress");

export type Field = "username" | "pubkey";

export interface DataCipher {
  /** Deterministic keyed hash, so a row can be found without storing the plaintext. */
  lookupHash(field: Field, value: string): Buffer;
  /** `context` is bound into the tag: a ciphertext only decrypts in the row it was written for. */
  encrypt(field: Field, value: string, context: Buffer): Buffer;
  decrypt(field: Field, sealed: Buffer, context: Buffer): string;
}

export function parseDataKey(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(value, "hex");
}

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, info, 32));
}

export function createDataCipher(masterKey: Buffer): DataCipher {
  const encryptionKey = derive(masterKey, "encryption-v1");
  const indexKey = derive(masterKey, "lookup-index-v1");
  const aad = (field: Field, context: Buffer) => Buffer.concat([Buffer.from(`${field}:`), context]);

  return {
    lookupHash(field, value) {
      return createHmac("sha256", indexKey).update(`${field}:${value}`).digest();
    },

    encrypt(field, value, context) {
      const nonce = randomBytes(NONCE_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(aad(field, context));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
    },

    decrypt(field, sealed, context) {
      if (sealed.length < 1 + NONCE_LENGTH + TAG_LENGTH || sealed[0] !== VERSION) throw new Error("unrecognised encrypted value");
      const nonce = sealed.subarray(1, 1 + NONCE_LENGTH);
      const tag = sealed.subarray(1 + NONCE_LENGTH, 1 + NONCE_LENGTH + TAG_LENGTH);
      const ciphertext = sealed.subarray(1 + NONCE_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
      decipher.setAAD(aad(field, context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
