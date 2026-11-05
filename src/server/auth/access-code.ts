import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
) => Promise<Buffer>;

const KEY_LENGTH = 32;

// Stored as `scrypt$<salt>$<hash>`, both base64url.
export async function hashAccessCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(code, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyAccessCode(
  code: string,
  stored: string,
): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(
    code,
    Buffer.from(salt, "base64url"),
    KEY_LENGTH,
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
