export interface BackendConfig {
  databaseUrl: string;
  /** Shopify app client secret — signs webhooks (HMAC) and session tokens (HS256). */
  apiSecret: string;
  /** Shopify app client id — the `aud` claim of session tokens. */
  apiKey: string;
  port: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
  };
  return {
    databaseUrl: required('DATABASE_URL'),
    apiSecret: required('SHOPIFY_API_SECRET'),
    apiKey: required('SHOPIFY_API_KEY'),
    port: Number(env['PORT'] ?? 3000),
  };
}
