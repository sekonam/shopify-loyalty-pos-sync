import { jwtVerify } from 'jose';

export interface SessionTokenClaims {
  /** myshopify domain extracted from `dest`, e.g. "my-store.myshopify.com". */
  shopDomain: string;
  /** Shopify user id (`sub`), when present. */
  userId?: string;
}

/**
 * Verifies a Shopify session token (the JWT checkout/POS UI extensions attach
 * when calling the app's backend): HS256 signed with the app's API secret,
 * `aud` must be the app's client id, `dest` names the shop. jose enforces
 * exp/nbf. Throws on any failure — callers map that to 401.
 */
export async function verifySessionToken(
  token: string,
  apiSecret: string,
  apiKey: string,
): Promise<SessionTokenClaims> {
  const secret = new TextEncoder().encode(apiSecret);
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    audience: apiKey,
    clockTolerance: 5,
  });
  const dest = typeof payload['dest'] === 'string' ? payload['dest'] : undefined;
  const shopDomain = dest ? new URL(dest).hostname : undefined;
  if (!shopDomain || !shopDomain.endsWith('.myshopify.com')) {
    throw new Error('Session token has no valid shop destination');
  }
  return {
    shopDomain,
    ...(typeof payload.sub === 'string' ? { userId: payload.sub } : {}),
  };
}
