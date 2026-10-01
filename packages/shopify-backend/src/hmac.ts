import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Shopify's webhook signature: base64(HMAC-SHA256(rawBody, apiSecret))
 * compared against the X-Shopify-Hmac-Sha256 header, constant-time.
 * MUST run on the raw request bytes, before any JSON parsing.
 */
export function verifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string | undefined,
  apiSecret: string,
): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac('sha256', apiSecret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, 'base64');
  } catch {
    return false;
  }
  return digest.length === provided.length && timingSafeEqual(digest, provided);
}
