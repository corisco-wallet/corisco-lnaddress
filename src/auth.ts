import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";

const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

export function isValidPubkey(hex: string): boolean {
  if (!PUBKEY_RE.test(hex)) return false;
  try {
    secp256k1.Point.fromHex(hex);
    return true;
  } catch {
    return false;
  }
}

export function registrationDigest(nonce: string, domain: string): Uint8Array {
  return sha256(new TextEncoder().encode(`corisco-lnaddr:v1:${nonce}:${domain}`));
}

/** The firmware signs a 32-byte digest; accept compact (64 bytes) or DER as returned by the signer. */
export function verifyRegistrationSignature(identityPubkey: string, nonce: string, domain: string, signatureHex: string): boolean {
  if (!isValidPubkey(identityPubkey) || !/^([0-9a-f]{2})+$/i.test(signatureHex)) return false;
  const signature = hexToBytes(signatureHex);
  const format = signature.length === 64 ? "compact" : "der";
  try {
    return secp256k1.verify(signature, registrationDigest(nonce, domain), hexToBytes(identityPubkey), {
      prehash: false,
      format,
    });
  } catch {
    return false;
  }
}

