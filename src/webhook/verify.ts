import crypto from "node:crypto";
import type { WebhookEventPayload } from "../types/multihopper.js";

export const MULTIHOPPER_SIGNATURE_HEADER = "x-multihopper-signature";

/**
 * Computes the expected HMAC-SHA256 hex signature for a MultiHopper webhook payload.
 */
export function computeWebhookSignature(payload: string | Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verifies the `x-multihopper-signature` header using constant-time comparison.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const normalizedSig = signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedSig)) {
    return false;
  }

  const expected = computeWebhookSignature(payload, secret);
  const sigBuf = Buffer.from(normalizedSig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export function parseVerifiedWebhook<T = Record<string, unknown>>(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string
): WebhookEventPayload<T> {
  if (!verifyWebhookSignature(rawBody, signatureHeader, secret)) {
    throw new Error("Invalid MultiHopper webhook HMAC-SHA256 signature");
  }
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  return JSON.parse(text) as WebhookEventPayload<T>;
}
