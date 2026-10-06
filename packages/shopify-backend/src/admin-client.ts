import type { AdminOrdersClient, ReconOrder } from './reconciliation.js';

/**
 * GraphQL Admin API client for the reconciliation job. Field names verified
 * against the 2026-10 schema (Order.sourceName, totalPriceSet, refunds as a
 * plain list, Refund.totalRefundedSet) on 2026-10-01. read_orders covers the
 * last 60 days — enough for an hourly diff; deeper backfills need
 * read_all_orders (Shopify-approval-gated).
 */

export const ADMIN_API_VERSION = '2026-07';

const RECON_QUERY = /* GraphQL */ `
  query Recon($query: String!, $cursor: String) {
    orders(first: 50, after: $cursor, sortKey: UPDATED_AT, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sourceName
        test
        displayFinancialStatus
        customer {
          id
        }
        totalPriceSet {
          shopMoney {
            amount
          }
        }
        refunds(first: 50) {
          id
          totalRefundedSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
`;

export interface TokenProvider {
  accessTokenFor(shopDomain: string): Promise<string | undefined>;
}

interface ReconQueryResponse {
  data?: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        id: string;
        sourceName: string | null;
        test: boolean;
        displayFinancialStatus: string | null;
        customer: { id: string } | null;
        totalPriceSet: { shopMoney: { amount: string } };
        refunds: Array<{ id: string; totalRefundedSet: { shopMoney: { amount: string } } }>;
      }>;
    };
  };
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export class GraphqlAdminOrdersClient implements AdminOrdersClient {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiVersion: string = ADMIN_API_VERSION,
  ) {}

  async ordersUpdatedSince(
    shopDomain: string,
    since: Date,
    cursor?: string,
  ): Promise<{ orders: ReconOrder[]; nextCursor?: string }> {
    const token = await this.tokens.accessTokenFor(shopDomain);
    if (!token) throw new Error(`No Admin API token stored for ${shopDomain}`);
    const res = await this.fetchImpl(
      `https://${shopDomain}/admin/api/${this.apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-access-token': token,
        },
        body: JSON.stringify({
          query: RECON_QUERY,
          variables: {
            query: `updated_at:>='${since.toISOString()}'`,
            cursor: cursor ?? null,
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`Admin API ${res.status} for ${shopDomain}`);
    const body = (await res.json()) as ReconQueryResponse;
    if (body.errors?.length) {
      throw new Error(
        `Admin API errors for ${shopDomain}: ${body.errors.map((e) => e.message).join('; ')}`,
      );
    }
    const page = body.data?.orders;
    if (!page) throw new Error(`Admin API returned no orders payload for ${shopDomain}`);
    const orders: ReconOrder[] = page.nodes.map((n) => ({
      id: n.id,
      sourceName: n.sourceName,
      test: n.test,
      financialStatus: n.displayFinancialStatus,
      ...(n.customer ? { customerId: n.customer.id } : {}),
      totalPrice: n.totalPriceSet.shopMoney.amount,
      refunds: n.refunds.map((r) => ({
        id: r.id,
        totalRefunded: r.totalRefundedSet.shopMoney.amount,
      })),
    }));
    return {
      orders,
      ...(page.pageInfo.hasNextPage && page.pageInfo.endCursor
        ? { nextCursor: page.pageInfo.endCursor }
        : {}),
    };
  }
}

/**
 * Who a customer id actually is. The ledger stores Shopify customer gids and
 * nothing else — correct, since names are Shopify's record to keep and this
 * app must not hold a stale copy of PII it would then have to redact. But an
 * admin that shows a merchant "6123456789 +89 Earned POS" has made them do
 * the join by hand, so the page resolves ids to names at read time and keeps
 * nothing beyond a short cache.
 */
export interface CustomerSummary {
  id: string;
  displayName: string;
  email: string | null;
}

export interface CustomerDirectory {
  /** Names for ids already on screen. Unknown ids are simply absent. */
  lookup(shopDomain: string, ids: string[]): Promise<CustomerSummary[]>;
  /** Free-text search over Shopify's own customer index (name, email, phone). */
  search(shopDomain: string, query: string): Promise<CustomerSummary[]>;
  /**
   * Drop anything cached about a customer. Called from the customers/redact
   * handler: this app holds names only in memory and only briefly, but once
   * Shopify has told us to forget someone, serving their name from a cache
   * for another five minutes is not something to defend at app review.
   */
  forget(shopDomain: string, customerId: string): void;
}

const CUSTOMER_FIELDS = /* GraphQL */ `
  id
  displayName
  email
`;

const CUSTOMER_NODES_QUERY = /* GraphQL */ `
  query CustomerNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer {
        ${CUSTOMER_FIELDS}
      }
    }
  }
`;

const CUSTOMER_SEARCH_QUERY = /* GraphQL */ `
  query CustomerSearch($query: String!, $first: Int!) {
    customers(first: $first, query: $query) {
      nodes {
        ${CUSTOMER_FIELDS}
      }
    }
  }
`;

/** Shopify's own cap on nodes(ids:) in one call. */
const MAX_NODES_PER_CALL = 250;
export const CUSTOMER_SEARCH_LIMIT = 10;
/**
 * Names change rarely and a dashboard re-reads the same page of the ledger
 * constantly, so a short per-shop cache keeps a tab refresh from costing an
 * Admin API call per visible customer. Deliberately short: a merchant who
 * corrects a misspelled name expects to see it fixed on the next look.
 */
const NAME_TTL_MS = 5 * 60 * 1000;
/**
 * Hard ceiling on remembered names, so a long-lived process paging a large
 * shop's ledger cannot grow this map without bound. Oldest-written go first;
 * losing one only costs a re-read.
 */
const MAX_CACHED_NAMES = 5000;

interface CustomerNode {
  id?: string;
  displayName?: string | null;
  email?: string | null;
}

function toSummary(node: CustomerNode | null): CustomerSummary | undefined {
  if (!node?.id) return undefined;
  return {
    id: node.id,
    // A customer with no name at all still has to be nameable on screen.
    displayName: node.displayName?.trim() || node.email?.trim() || 'Unnamed customer',
    email: node.email ?? null,
  };
}

export class GraphqlCustomerDirectory implements CustomerDirectory {
  private readonly cache = new Map<string, { summary: CustomerSummary; at: number }>();

  constructor(
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiVersion: string = ADMIN_API_VERSION,
    private readonly now: () => number = Date.now,
  ) {}

  private async query<T>(
    shopDomain: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.tokens.accessTokenFor(shopDomain);
    if (!token) throw new Error(`No Admin API token stored for ${shopDomain}`);
    const res = await this.fetchImpl(
      `https://${shopDomain}/admin/api/${this.apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query, variables }),
      },
    );
    if (!res.ok) throw new Error(`Admin API ${res.status} for ${shopDomain}`);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(
        `Admin API errors for ${shopDomain}: ${body.errors.map((e) => e.message).join('; ')}`,
      );
    }
    if (!body.data) throw new Error(`Admin API returned no data for ${shopDomain}`);
    return body.data;
  }

  private cacheKey(shopDomain: string, id: string): string {
    // Neither a shop domain nor a gid can contain a space.
    return `${shopDomain} ${id}`;
  }

  private remember(shopDomain: string, summary: CustomerSummary): CustomerSummary {
    const key = this.cacheKey(shopDomain, summary.id);
    // Re-set moves the key to the end of the Map's insertion order, which is
    // what makes the eviction below oldest-first.
    this.cache.delete(key);
    this.cache.set(key, { summary, at: this.now() });
    while (this.cache.size > MAX_CACHED_NAMES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return summary;
  }

  forget(shopDomain: string, customerId: string): void {
    this.cache.delete(this.cacheKey(shopDomain, customerId));
  }

  async lookup(shopDomain: string, ids: string[]): Promise<CustomerSummary[]> {
    const found: CustomerSummary[] = [];
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const key = this.cacheKey(shopDomain, id);
      const hit = this.cache.get(key);
      if (hit && this.now() - hit.at < NAME_TTL_MS) found.push(hit.summary);
      else {
        if (hit) this.cache.delete(key);
        missing.push(id);
      }
    }
    for (let i = 0; i < missing.length; i += MAX_NODES_PER_CALL) {
      const batch = missing.slice(i, i + MAX_NODES_PER_CALL);
      const data = await this.query<{ nodes: Array<CustomerNode | null> }>(
        shopDomain,
        CUSTOMER_NODES_QUERY,
        { ids: batch },
      );
      // A deleted or redacted customer comes back as a null node; the ledger
      // keeps its entries either way, so the page falls back to the bare id.
      for (const node of data.nodes) {
        const summary = toSummary(node);
        if (summary) found.push(this.remember(shopDomain, summary));
      }
    }
    return found;
  }

  async search(shopDomain: string, query: string): Promise<CustomerSummary[]> {
    const data = await this.query<{ customers: { nodes: CustomerNode[] } }>(
      shopDomain,
      CUSTOMER_SEARCH_QUERY,
      { query, first: CUSTOMER_SEARCH_LIMIT },
    );
    const results: CustomerSummary[] = [];
    for (const node of data.customers.nodes) {
      const summary = toSummary(node);
      if (summary) results.push(this.remember(shopDomain, summary));
    }
    return results;
  }
}
