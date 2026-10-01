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
