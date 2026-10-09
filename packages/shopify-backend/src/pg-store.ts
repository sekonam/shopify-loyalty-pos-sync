import type {
  AppendResult,
  EntryFilter,
  LedgerEntryDraft,
  LedgerStats,
  LedgerStore,
  PointsLedgerEntry,
  RedeemRequest,
  RedeemResult,
  RedemptionAttempt,
  RedemptionStatus,
} from '@loyalty/ledger';
import { checkRedemption, redemptionKey } from '@loyalty/ledger';
import type pg from 'pg';
import { withTransaction, type Db } from './db.js';

/**
 * Postgres implementation of the LedgerStore contract. Atomicity of `redeem`
 * comes from a per-(shop, customer) transaction-scoped advisory lock: the
 * balance read and the ledger append are a single critical section, so a
 * concurrent redemption (the POS/online race) serializes instead of
 * double-spending. The InMemoryLedgerStore in @loyalty/ledger is the
 * executable specification this must match; the shared conformance test
 * suite runs against both.
 */
export class PgLedgerStore implements LedgerStore {
  constructor(private readonly db: Db) {}

  async append(draft: LedgerEntryDraft): Promise<AppendResult> {
    return withTransaction(this.db, async (client) => {
      await this.lockCustomer(client, draft.shopDomain, draft.customerId);
      return this.appendInTx(client, draft);
    });
  }

  async appendCapped(draft: LedgerEntryDraft): Promise<AppendResult | null> {
    if (!Number.isInteger(draft.delta) || draft.delta >= 0) {
      throw new Error(`appendCapped requires a negative integer delta, got ${draft.delta}`);
    }
    return withTransaction(this.db, async (client) => {
      await this.lockCustomer(client, draft.shopDomain, draft.customerId);
      const existing = await client.query(
        'select * from points_ledger_entry where shop_domain = $1 and idempotency_key = $2',
        [draft.shopDomain, draft.idempotencyKey],
      );
      if (existing.rows[0]) return { entry: rowToEntry(existing.rows[0]), inserted: false };
      const balance = await this.balanceInTx(client, draft.shopDomain, draft.customerId);
      const capped = Math.min(-draft.delta, Math.max(balance, 0));
      if (capped <= 0) return null;
      return this.appendInTx(client, { ...draft, delta: -capped });
    });
  }

  async balance(shopDomain: string, customerId: string): Promise<number> {
    const { rows } = await this.db.query(
      `select coalesce(sum(delta), 0)::int as balance
         from points_ledger_entry
        where shop_domain = $1 and customer_id = $2`,
      [shopDomain, customerId],
    );
    return rows[0].balance as number;
  }

  async entries(shopDomain: string, customerId: string): Promise<PointsLedgerEntry[]> {
    const { rows } = await this.db.query(
      `select * from points_ledger_entry
        where shop_domain = $1 and customer_id = $2
        order by created_at, id`,
      [shopDomain, customerId],
    );
    return rows.map(rowToEntry);
  }

  async redeem(request: RedeemRequest): Promise<RedeemResult> {
    if (!Number.isInteger(request.requestedPoints) || request.requestedPoints <= 0) {
      throw new Error(`requestedPoints must be a positive integer, got ${request.requestedPoints}`);
    }
    return withTransaction(this.db, async (client) => {
      await this.lockCustomer(client, request.shopDomain, request.customerId);

      const existing = await client.query(
        'select * from redemption_attempt where shop_domain = $1 and id::text = $2',
        [request.shopDomain, request.attemptId],
      );
      if (existing.rows[0]) {
        return this.replayResult(client, rowToAttempt(existing.rows[0]), request);
      }

      const balance = await this.balanceInTx(client, request.shopDomain, request.customerId);
      const check = checkRedemption({
        balance,
        requestedPoints: request.requestedPoints,
        minRedemption: request.minRedemption,
      });
      const status: RedemptionStatus = check.ok ? 'applied' : check.status;
      const attemptRow = await client.query(
        `insert into redemption_attempt
           (id, shop_domain, customer_id, channel, requested_points, status, pos_device_id, resolved_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         returning *`,
        [
          request.attemptId,
          request.shopDomain,
          request.customerId,
          request.channel,
          request.requestedPoints,
          status,
          request.posDeviceId ?? null,
        ],
      );
      const attempt = rowToAttempt(attemptRow.rows[0]);
      if (!check.ok) {
        return { status: check.status, attempt, balance };
      }
      const { entry } = await this.appendInTx(client, {
        shopDomain: request.shopDomain,
        customerId: request.customerId,
        sourceName: request.channel === 'pos' ? 'pos' : 'web',
        delta: -request.requestedPoints,
        reason: 'redeem',
        redemptionAttemptId: request.attemptId,
        idempotencyKey: redemptionKey(request.attemptId),
      });
      return { status: 'applied', attempt, entry, balance: balance - request.requestedPoints };
    });
  }

  async getAttempt(shopDomain: string, attemptId: string): Promise<RedemptionAttempt | undefined> {
    // id::text comparison: attemptId can be caller-supplied (e.g. a customer-
    // editable note attribute) — a non-UUID value must miss, not raise 22P02.
    const { rows } = await this.db.query(
      'select * from redemption_attempt where shop_domain = $1 and id::text = $2',
      [shopDomain, attemptId],
    );
    return rows[0] ? rowToAttempt(rows[0]) : undefined;
  }

  async hasEntry(shopDomain: string, idempotencyKey: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'select 1 from points_ledger_entry where shop_domain = $1 and idempotency_key = $2',
      [shopDomain, idempotencyKey],
    );
    return (rowCount ?? 0) > 0;
  }

  async findByOrder(
    shopDomain: string,
    orderId: string,
    reason?: PointsLedgerEntry['reason'],
  ): Promise<PointsLedgerEntry | undefined> {
    const { rows } = await this.db.query(
      `select * from points_ledger_entry
        where shop_domain = $1 and order_id = $2 and ($3::text is null or reason = $3)
        order by created_at, id limit 1`,
      [shopDomain, orderId, reason ?? null],
    );
    return rows[0] ? rowToEntry(rows[0]) : undefined;
  }

  async earnedSince(shopDomain: string, customerId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query(
      `select coalesce(sum(delta), 0)::int as earned
         from points_ledger_entry
        where shop_domain = $1 and customer_id = $2
          and delta > 0 and reason in ('earn', 'reconciliation')
          and created_at >= $3`,
      [shopDomain, customerId, since],
    );
    return rows[0].earned as number;
  }

  async hasEarnFromOtherOrder(
    shopDomain: string,
    customerId: string,
    orderId: string,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `select 1 from points_ledger_entry
        where shop_domain = $1 and customer_id = $2
          and delta > 0 and reason in ('earn', 'reconciliation')
          and order_id is not null and order_id <> $3
        limit 1`,
      [shopDomain, customerId, orderId],
    );
    return (rowCount ?? 0) > 0;
  }

  async orderDeltas(
    shopDomain: string,
    orderId: string,
  ): Promise<{ earned: number; reversed: number }> {
    const { rows } = await this.db.query(
      `select
         coalesce(sum(delta) filter (where reason in ('earn', 'reconciliation') and delta > 0), 0)::int as earned,
         coalesce(sum(-delta) filter (where reason = 'refund_reversal'), 0)::int as reversed
       from points_ledger_entry
       where shop_domain = $1 and order_id = $2`,
      [shopDomain, orderId],
    );
    return { earned: rows[0].earned as number, reversed: rows[0].reversed as number };
  }

  async stats(shopDomain: string, windowStart: Date): Promise<LedgerStats> {
    const { rows } = await this.db.query(
      `with balances as (
         select customer_id, sum(delta)::int as balance
           from points_ledger_entry where shop_domain = $1
          group by customer_id
       )
       select
         (select count(*) from balances where balance > 0)::int as members,
         (select coalesce(sum(balance), 0) from balances)::int as outstanding_points,
         (select count(*) from points_ledger_entry where shop_domain = $1)::int as entry_count,
         (select coalesce(sum(delta), 0) from points_ledger_entry
           where shop_domain = $1 and delta > 0 and created_at >= $2)::int as issued,
         (select coalesce(sum(-delta), 0) from points_ledger_entry
           where shop_domain = $1 and delta < 0 and created_at >= $2)::int as redeemed`,
      [shopDomain, windowStart],
    );
    return {
      members: rows[0].members as number,
      outstandingPoints: rows[0].outstanding_points as number,
      entryCount: rows[0].entry_count as number,
      issuedInWindow: rows[0].issued as number,
      redeemedInWindow: rows[0].redeemed as number,
    };
  }

  async entryPage(
    shopDomain: string,
    filter: EntryFilter,
    limit: number,
  ): Promise<{ entries: PointsLedgerEntry[]; total: number }> {
    const { where, params } = entryWhere(shopDomain, filter);
    // One round trip: the page and the count of everything that matches it.
    // They have to come from the same predicate or the admin's "N of M match"
    // is comparing two different questions.
    const [page, count] = await Promise.all([
      this.db.query(
        `select * from (
           select * from points_ledger_entry
            where ${where}
            order by created_at desc, id desc
            limit $${params.length + 1}
         ) recent
         order by created_at, id`,
        [...params, limit],
      ),
      this.db.query(`select count(*)::int as total from points_ledger_entry where ${where}`, params),
    ]);
    return { entries: page.rows.map(rowToEntry), total: count.rows[0].total as number };
  }

  async *streamEntries(
    shopDomain: string,
    filter: EntryFilter,
    batchSize = 2_000,
  ): AsyncIterable<PointsLedgerEntry[]> {
    const { where, params } = entryWhere(shopDomain, filter);
    // Keyset pagination on the same (created_at, id) pair the rows are ordered
    // by. OFFSET would re-scan everything it already skipped, and a row
    // inserted mid-export would shift the window and duplicate or drop a row —
    // in an audit export, silently.
    //
    // The cursor travels as TEXT, not as the Date the driver hands back:
    // Postgres keeps microseconds and a JS Date only milliseconds, so a
    // round-tripped timestamp lands slightly BEFORE the row it came from and
    // the same batch is served forever. Rows sharing one `now()` — every row
    // written by a single statement — make that an immediate infinite loop.
    let cursor: { createdAt: string; id: string } | undefined;
    for (;;) {
      const keyset =
        cursor === undefined
          ? ''
          : `and (created_at, id) > ($${params.length + 1}::timestamptz, $${params.length + 2}::uuid)`;
      const cursorParams = cursor === undefined ? [] : [cursor.createdAt, cursor.id];
      const { rows } = await this.db.query(
        `select *, created_at::text as cursor_ts from points_ledger_entry
          where ${where} ${keyset}
          order by created_at, id
          limit $${params.length + cursorParams.length + 1}`,
        [...params, ...cursorParams, batchSize],
      );
      if (rows.length === 0) return;
      yield rows.map(rowToEntry);
      if (rows.length < batchSize) return;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.cursor_ts as string, id: last.id as string };
    }
  }

  private async lockCustomer(
    client: pg.PoolClient,
    shopDomain: string,
    customerId: string,
  ): Promise<void> {
    //  separator: cannot appear in a shop domain or GID, and Postgres
    // text rejects NUL bytes.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${shopDomain}${customerId}`,
    ]);
  }

  private async balanceInTx(
    client: pg.PoolClient,
    shopDomain: string,
    customerId: string,
  ): Promise<number> {
    const { rows } = await client.query(
      `select coalesce(sum(delta), 0)::int as balance
         from points_ledger_entry
        where shop_domain = $1 and customer_id = $2`,
      [shopDomain, customerId],
    );
    return rows[0].balance as number;
  }

  private async appendInTx(client: pg.PoolClient, draft: LedgerEntryDraft): Promise<AppendResult> {
    if (!Number.isInteger(draft.delta) || draft.delta === 0) {
      throw new Error(`Ledger delta must be a nonzero integer, got ${draft.delta}`);
    }
    const inserted = await client.query(
      `insert into points_ledger_entry
         (shop_domain, customer_id, order_id, refund_id, source_name, raw_source_name,
          delta, earn_rate, reason, redemption_attempt_id, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11)
       on conflict (shop_domain, idempotency_key) do nothing
       returning *`,
      [
        draft.shopDomain,
        draft.customerId,
        draft.orderId ?? null,
        draft.refundId ?? null,
        draft.sourceName,
        draft.rawSourceName ?? null,
        draft.delta,
        draft.earnRate ?? null,
        draft.reason,
        draft.redemptionAttemptId ?? null,
        draft.idempotencyKey,
      ],
    );
    if (inserted.rows[0]) return { entry: rowToEntry(inserted.rows[0]), inserted: true };
    const existing = await client.query(
      'select * from points_ledger_entry where shop_domain = $1 and idempotency_key = $2',
      [draft.shopDomain, draft.idempotencyKey],
    );
    return { entry: rowToEntry(existing.rows[0]), inserted: false };
  }

  private async replayResult(
    client: pg.PoolClient,
    attempt: RedemptionAttempt,
    request: RedeemRequest,
  ): Promise<RedeemResult> {
    const balance = await this.balanceInTx(client, request.shopDomain, request.customerId);
    if (attempt.status === 'applied') {
      const { rows } = await client.query(
        'select * from points_ledger_entry where shop_domain = $1 and redemption_attempt_id = $2',
        [request.shopDomain, attempt.id],
      );
      if (!rows[0]) throw new Error(`Applied attempt ${attempt.id} has no ledger entry`);
      return { status: 'applied', attempt, entry: rowToEntry(rows[0]), balance };
    }
    return {
      status: attempt.status as Exclude<RedemptionStatus, 'applied' | 'pending'>,
      attempt,
      balance,
    };
  }
}

/**
 * The one place an EntryFilter becomes SQL. The admin's page, its total, and
 * its CSV export all build their query from this, so "what the merchant is
 * looking at" and "what they downloaded" cannot drift apart.
 */
function entryWhere(
  shopDomain: string,
  filter: EntryFilter,
): { where: string; params: unknown[] } {
  const clauses = ['shop_domain = $1'];
  const params: unknown[] = [shopDomain];
  for (const [column, value] of [
    ['customer_id', filter.customerId],
    ['reason', filter.reason],
    ['source_name', filter.channel],
  ] as const) {
    if (value === undefined) continue;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  }
  return { where: clauses.join(' and '), params };
}

function rowToEntry(row: Record<string, unknown>): PointsLedgerEntry {
  return {
    id: row['id'] as string,
    shopDomain: row['shop_domain'] as string,
    customerId: row['customer_id'] as string,
    ...(row['order_id'] != null ? { orderId: row['order_id'] as string } : {}),
    ...(row['refund_id'] != null ? { refundId: row['refund_id'] as string } : {}),
    sourceName: row['source_name'] as PointsLedgerEntry['sourceName'],
    ...(row['raw_source_name'] != null ? { rawSourceName: row['raw_source_name'] as string } : {}),
    delta: row['delta'] as number,
    ...(row['earn_rate'] != null ? { earnRate: String(row['earn_rate']) } : {}),
    reason: row['reason'] as PointsLedgerEntry['reason'],
    ...(row['redemption_attempt_id'] != null
      ? { redemptionAttemptId: row['redemption_attempt_id'] as string }
      : {}),
    idempotencyKey: row['idempotency_key'] as string,
    createdAt: new Date(row['created_at'] as string),
  };
}

function rowToAttempt(row: Record<string, unknown>): RedemptionAttempt {
  return {
    id: row['id'] as string,
    shopDomain: row['shop_domain'] as string,
    customerId: row['customer_id'] as string,
    channel: row['channel'] as RedemptionAttempt['channel'],
    requestedPoints: row['requested_points'] as number,
    status: row['status'] as RedemptionStatus,
    ...(row['pos_device_id'] != null ? { posDeviceId: row['pos_device_id'] as string } : {}),
    createdAt: new Date(row['created_at'] as string),
    ...(row['resolved_at'] != null ? { resolvedAt: new Date(row['resolved_at'] as string) } : {}),
  };
}
