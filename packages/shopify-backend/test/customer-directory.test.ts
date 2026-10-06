import { describe, expect, it } from 'vitest';
import { GraphqlCustomerDirectory, type CustomerSummary } from '../src/admin-client.js';

const SHOP = 'test-shop.myshopify.com';
const gid = (n: string) => `gid://shopify/Customer/${n}`;

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

/** Records every Admin API call and answers with canned nodes. */
function stubFetch(answers: unknown[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Call;
    calls.push(body);
    const data = answers[Math.min(i++, answers.length - 1)];
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const tokens = { accessTokenFor: async () => 'shpat_test' };

describe('GraphqlCustomerDirectory', () => {
  it('resolves ids to names', async () => {
    const { fetch, calls } = stubFetch([
      { nodes: [{ id: gid('1'), displayName: 'Dana Whitfield', email: 'dana@example.com' }] },
    ]);
    const dir = new GraphqlCustomerDirectory(tokens, fetch);
    expect(await dir.lookup(SHOP, [gid('1')])).toEqual([
      { id: gid('1'), displayName: 'Dana Whitfield', email: 'dana@example.com' },
    ]);
    expect(calls[0]?.variables['ids']).toEqual([gid('1')]);
  });

  /*
   * A customer deleted or GDPR-redacted in Shopify comes back as a null node.
   * Their ledger entries still exist and must still be listed — under the bare
   * id, which is all that is left of them.
   */
  it('skips nodes Shopify no longer has', async () => {
    const { fetch } = stubFetch([{ nodes: [null, { id: gid('2'), displayName: 'Tom Beck' }] }]);
    const dir = new GraphqlCustomerDirectory(tokens, fetch);
    const found = await dir.lookup(SHOP, [gid('1'), gid('2')]);
    expect(found.map((c: CustomerSummary) => c.id)).toEqual([gid('2')]);
    expect(found[0]?.email).toBeNull();
  });

  it('falls back to the email, then to a placeholder, when there is no name', async () => {
    const { fetch } = stubFetch([
      {
        nodes: [
          { id: gid('1'), displayName: '  ', email: 'only@example.com' },
          { id: gid('2'), displayName: null, email: null },
        ],
      },
    ]);
    const dir = new GraphqlCustomerDirectory(tokens, fetch);
    const found = await dir.lookup(SHOP, [gid('1'), gid('2')]);
    expect(found.map((c: CustomerSummary) => c.displayName)).toEqual([
      'only@example.com',
      'Unnamed customer',
    ]);
  });

  it('caches within the TTL and re-reads after it, per shop', async () => {
    let now = 0;
    const { fetch, calls } = stubFetch([
      { nodes: [{ id: gid('1'), displayName: 'Dana Whitfield', email: null }] },
    ]);
    const dir = new GraphqlCustomerDirectory(tokens, fetch, undefined, () => now);
    await dir.lookup(SHOP, [gid('1')]);
    await dir.lookup(SHOP, [gid('1')]);
    expect(calls).toHaveLength(1);
    // A second shop never reads the first shop's cache.
    await dir.lookup('other.myshopify.com', [gid('1')]);
    expect(calls).toHaveLength(2);
    now += 5 * 60 * 1000 + 1;
    await dir.lookup(SHOP, [gid('1')]);
    expect(calls).toHaveLength(3);
  });

  it('asks only for the ids it does not already hold', async () => {
    const { fetch, calls } = stubFetch([
      { nodes: [{ id: gid('1'), displayName: 'Dana Whitfield', email: null }] },
      { nodes: [{ id: gid('2'), displayName: 'Tom Beck', email: null }] },
    ]);
    const dir = new GraphqlCustomerDirectory(tokens, fetch);
    await dir.lookup(SHOP, [gid('1')]);
    await dir.lookup(SHOP, [gid('1'), gid('2')]);
    expect(calls[1]?.variables['ids']).toEqual([gid('2')]);
  });

  it('surfaces a GraphQL error rather than returning empty names', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Access denied' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const dir = new GraphqlCustomerDirectory(tokens, impl);
    await expect(dir.lookup(SHOP, [gid('1')])).rejects.toThrow('Access denied');
  });

  it('refuses to call Shopify without a stored token', async () => {
    const { fetch, calls } = stubFetch([{ nodes: [] }]);
    const dir = new GraphqlCustomerDirectory({ accessTokenFor: async () => undefined }, fetch);
    await expect(dir.lookup(SHOP, [gid('1')])).rejects.toThrow('No Admin API token');
    expect(calls).toHaveLength(0);
  });

  it('searches Shopify customers by free text', async () => {
    const { fetch, calls } = stubFetch([
      { customers: { nodes: [{ id: gid('3'), displayName: 'Priya Ramanathan', email: null }] } },
    ]);
    const dir = new GraphqlCustomerDirectory(tokens, fetch);
    const found = await dir.search(SHOP, 'priya');
    expect(found[0]?.displayName).toBe('Priya Ramanathan');
    expect(calls[0]?.variables['query']).toBe('priya');
    // A search result is a name the page will draw next — cache it too.
    await dir.lookup(SHOP, [gid('3')]);
    expect(calls).toHaveLength(1);
  });
});
