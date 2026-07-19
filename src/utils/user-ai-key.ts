import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { User } from "../modules/models.js";

const algorithm = "aes-256-gcm";

export class AiProviderError extends Error {
  constructor(message: string, public statusCode: number, public code: "AI_RATE_LIMIT" | "AI_PROVIDER_ERROR") {
    super(message);
  }
}

function encryptionKey() {
  if (env.aiKeyEncryptionSecret.length < 32) throw new Error("AI key storage is not configured");
  return createHash("sha256").update(env.aiKeyEncryptionSecret).digest();
}

export function encryptUserAiKey(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptUserAiKey(value: string) {
  const [ivValue, tagValue, ciphertext] = value.split(".");
  if (!ivValue || !tagValue || !ciphertext) throw new Error("Stored AI key is invalid");
  const decipher = createDecipheriv(algorithm, encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function keyHint(value: string) {
  return `••••${value.slice(-4)}`;
}

export async function resolveGeminiApiKey(userId: string) {
  const user = await User.findById(userId).select("+aiKeyEncrypted").lean();
  if (user?.aiKeyEncrypted) return decryptUserAiKey(user.aiKeyEncrypted);
  if (env.geminiKey) return env.geminiKey;
  throw new Error("No Gemini API key is configured. Add one in Profile settings.");
}

export function aiKeyStorageConfigured() {
  return env.aiKeyEncryptionSecret.length >= 32;
}
