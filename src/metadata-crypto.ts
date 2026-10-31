import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from "node:crypto";

export const METADATA_ENCRYPTED_SCHEMA = "dsh-sci.encrypted-metadata.v1" as const;

export class MetadataLockedError extends Error {
  readonly code = "DSH_SCI_METADATA_LOCKED" as const;
  constructor(message = "Metadata is encrypted; set DSH_SCI_METADATA_PASSPHRASE to unlock it") {
    super(message);
    this.name = "MetadataLockedError";
  }
}

type MetadataEnvelope = {
  schema: typeof METADATA_ENCRYPTED_SCHEMA;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

const KEY_BYTES = 32;
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;

export function metadataPassphraseFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.DSH_SCI_METADATA_PASSPHRASE;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number } = SCRYPT): Buffer {
  if (typeof passphrase !== "string" || passphrase.length === 0) throw new Error("Metadata passphrase must be non-empty");
  return scryptSync(passphrase, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 });
}

function decode(value: unknown, name: string, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error(`Encrypted metadata has invalid ${name}`);
  const output = Buffer.from(value, "base64");
  if (!output.length || (length !== undefined && output.length !== length)) throw new Error(`Encrypted metadata has invalid ${name}`);
  return output;
}

function envelope(value: unknown): MetadataEnvelope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<MetadataEnvelope>;
  return candidate.schema === METADATA_ENCRYPTED_SCHEMA ? candidate as MetadataEnvelope : undefined;
}

export function isEncryptedMetadataText(text: string): boolean {
  try { return envelope(JSON.parse(text)) !== undefined; } catch { return false; }
}

export function encryptMetadataText(plaintext: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const result: MetadataEnvelope = {
    schema: METADATA_ENCRYPTED_SCHEMA,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    kdfParams: SCRYPT,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function decryptMetadataText(text: string, passphrase?: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  const value = envelope(parsed);
  if (!value) return text;
  if (!passphrase) throw new MetadataLockedError();
  if (value.algorithm !== "aes-256-gcm" || value.kdf !== "scrypt") throw new Error("Encrypted metadata uses an unsupported algorithm");
  const params = value.kdfParams;
  if (!params || params.N !== SCRYPT.N || params.r !== SCRYPT.r || params.p !== SCRYPT.p) throw new Error("Encrypted metadata uses unsupported KDF parameters");
  const salt = decode(value.salt, "salt", 16);
  const iv = decode(value.iv, "iv", 12);
  const tag = decode(value.tag, "authentication tag", 16);
  const ciphertext = decode(value.ciphertext, "ciphertext");
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt, params), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new MetadataLockedError("Metadata passphrase is invalid or the encrypted metadata is corrupted");
  }
}

export function parseMetadataJson<T>(text: string, passphrase?: string): T {
  return JSON.parse(decryptMetadataText(text, passphrase)) as T;
}

export function serializeMetadataJson(value: unknown, passphrase?: string): string {
  const plaintext = `${JSON.stringify(value, null, 2)}\n`;
  return passphrase ? encryptMetadataText(plaintext, passphrase) : plaintext;
}
