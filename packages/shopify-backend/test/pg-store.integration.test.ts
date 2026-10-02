/**
 * Integration conformance: PgLedgerStore must behave exactly like the
 * InMemoryLedgerStore reference on the behaviors the product stakes its
 * thesis on — idempotent appends, atomic redemption races, capped reversals.
 * Needs Docker; skip with SKIP_PG_TESTS=1.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerEntryDraft } from '@loyalty/ledger';
import { createPool, migrate, type Db } from '../src/db.js';
import { PgLedgerStore } from '../src/pg-store.js';
import { PgSettingsStore } from '../src/settings.js';
import { PgComplianceStore, redactedId } from '../src/compliance.js';
import { PgReferralStore } from '../src/referrals.js';

const SHOP = 'pg-test.myshopify.com';
const CUSTOMER = 'gid://shopify/Customer/1';

const earnDraft = (key: string, delta = 100, customerId = CUSTOMER): LedgerEntryDraft => ({
  shopDomain: SHOP,
  customerId,
  orderId: `gid://shopify/Order/${key}`,
  sourceName: 'web',
  delta,
  reason: 'earn',
  idempotencyKey: `order_paid:${key}`,
});

describe.skipIf(process.env['SKIP_PG_TESTS'] === '1')('PgLedgerStore (Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let store: PgLedgerStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    db = createPool(container.getConnectionUri());
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'migrations',
    );
    await migrate(db, migrationsDir);
    store = new PgLedgerStore(db);
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('append is idempotent and balance derives from SUM(delta)', async () => {
    const c = `gid://shopify/Customer/${randomUUID()}`;
    const first = await store.append(earnDraft('a1', 100, c));
    const replay = await store.append(earnDraft('a1', 100, c));
    await store.append(earnDraft('a2', 50, c));
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(await store.balance(SHOP, c)).toBe(150);
  });

  it('the schema rejects zero deltas and duplicate idempotency keys at the DB layer', async () => {
    const c = `gid://shopify/Customer/${randomUUID()}`;
    await expect(store.append({ ...earnDraft('z1', 0, c) })).rejects.toThrow();
    // Direct insert bypassing the store still cannot duplicate a key:
    await store.append(earnDraft('z2', 10, c));
    await expect(
      db.query(
        `insert into points_ledger_entry
           (shop_domain, customer_id, source_name, delta, reason, idempotency_key)
         values ($1, $2, 'web', 5, 'earn', $3)`,
        [SHOP, c, 'order_paid:z2'],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('race: concurrent redemptions that cannot both fit — exactly one applies', async () => {
    const c = `gid://shopify/Customer/${randomUUID()}`;
    await store.append(earnDraft(`r-${c}`, 300, c));
    const mk = (attemptId: string) =>
      store.redeem({
        shopDomain: SHOP,
        customerId: c,
        channel: 'pos',
        requestedPoints: 200,
        minRedemption: 1,
        attemptId,
      });
    const [a, b] = await Promise.all([mk(randomUUID()), mk(randomUUID())]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'rejected_insufficient_balance']);
    expect(await store.balance(SHOP, c)).toBe(100);
  });

  it('race: a swarm of single-point redemptions never overspends', async () => {
    const c = `gid://shopify/Customer/${randomUUID()}`;
    await store.append(earnDraft(`s-${c}`, 5, c));
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.redeem({
          shopDomain: SHOP,
          customerId: c,
          channel: 'web',
          requestedPoints: 1,
          minRedemption: 1,
          attemptId: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'applied')).toHaveLength(5);
    expect(await store.balance(SHOP, c)).toBe(0);
  });

  it('redeem is idempotent on attemptId across retries', async () => {
    const c = `gid://shopify/Customer/${randomUUID()}`;
    await store.append(earnDraft(`i-${c}`, 500, c));
    const attemptId = randomUUID();
    const req = {
      shopDomain: SHOP,
      customerId: c,
      channel: 'pos' as const,
      requestedPoints: 200,
      minRedemption: 1,
      attemptId,
    };
    const first = await store.redeem(req);
    const retry = await store.redeem(req);
    expect(first.status).toBe('applied');
    expect(retry.status).toBe('applied');
    expect(await store.balance(SHOP, c)).toBe(300);
  });

  it('appendCapped caps at the live balance inside the write', async () => {
    const c = `gid://shopify/Customer/${randomUUID()}`;
    await store.append(earnDraft(`c-${c}`, 30, c));
    const result = await store.appendCapped({
      shopDomain: SHOP,
      customerId: c,
      orderId: 'gid://shopify/Order/x',
      refundId: 'gid://shopify/Refund/x',
      sourceName: 'web',
      delta: -80,
      reason: 'refund_reversal',
      idempotencyKey: `refund:${c}`,
    });
    expect(result?.entry.delta).toBe(-30);
    expect(await store.balance(SHOP, c)).toBe(0);
    // Nothing left: a second (different-key) reversal returns null.
    const second = await store.appendCapped({
      shopDomain: SHOP,
      customerId: c,
      sourceName: 'web',
      delta: -10,
      reason: 'refund_reversal',
      idempotencyKey: `refund:${c}-2`,
    });
    expect(second).toBeNull();
  });

  it('earnedSince counts only purchase earns in the window', async () => {
    const c = `gid://shopify/Customer/${randomUUID()}`;
    await store.append(earnDraft(`e1-${c}`, 100, c));
    await store.append({ ...earnDraft(`e2-${c}`, 40, c), reason: 'reconciliation' });
    await store.append({ ...earnDraft(`e3-${c}`, 500, c), reason: 'referral_reward' });
    await store.redeem({
      shopDomain: SHOP,
      customerId: c,
      channel: 'web',
      requestedPoints: 50,
      minRedemption: 1,
      attemptId: randomUUID(),
    });
    expect(await store.earnedSince(SHOP, c, new Date(Date.now() - 60_000))).toBe(140);
    expect(await store.earnedSince(SHOP, c, new Date(Date.now() + 60_000))).toBe(0);
  });

  it('referral store: stable codes, lookup, one referral per friend', async () => {
    const referrals = new PgReferralStore(db);
    const advocate = `gid://shopify/Customer/${randomUUID()}`;
    const friend = `gid://shopify/Customer/${randomUUID()}`;
    const code = await referrals.codeFor(SHOP, advocate);
    expect(code).toMatch(/^[A-Z0-9]+$/);
    expect(await referrals.codeFor(SHOP, advocate)).toBe(code);
    expect(await referrals.advocateFor(SHOP, code)).toBe(advocate);
    expect(await referrals.advocateFor(SHOP, 'NO0PE')).toBeUndefined();
    const record = {
      advocateCustomerId: advocate,
      friendCustomerId: friend,
      code,
      orderId: 'gid://shopify/Order/1',
    };
    expect(await referrals.recordIfFirst(SHOP, record)).toBe(true);
    expect(
      await referrals.recordIfFirst(SHOP, { ...record, orderId: 'gid://shopify/Order/2' }),
    ).toBe(false);
  });

  it('settings config document round-trips and merges per-field', async () => {
    const settings = new PgSettingsStore(db);
    const shop = `cfg-${randomUUID().slice(0, 8)}.myshopify.com`;
    await settings.upsert(shop, {
      tiers: [{ name: 'Gold', minEarned365: 1000, multiplier: '2' }],
      referral: { enabled: true, advocatePoints: 300, friendPoints: 150 },
    });
    await settings.upsert(shop, { excludedSources: ['amazon'] }); // must not clobber tiers
    const loaded = await settings.get(shop);
    expect(loaded.tiers).toEqual([{ name: 'Gold', minEarned365: 1000, multiplier: '2' }]);
    expect(loaded.excludedSources).toEqual(['amazon']);
    expect(loaded.referral).toEqual({ enabled: true, advocatePoints: 300, friendPoints: 150 });
  });

  it('settings round-trip and customer redaction', async () => {
    const settings = new PgSettingsStore(db);
    await settings.upsert(SHOP, { earnRate: '2.5', minRedemption: 50 });
    expect(await settings.get(SHOP)).toMatchObject({
      earnRate: '2.5',
      redemptionRate: '100',
      minRedemption: 50,
    });

    const c = `gid://shopify/Customer/${randomUUID()}`;
    await store.append(earnDraft(`g-${c}`, 40, c));
    await new PgComplianceStore(db).redactCustomer(SHOP, c);
    expect(await store.balance(SHOP, c)).toBe(0);
    expect(await store.balance(SHOP, redactedId(c))).toBe(40); // aggregate survives, identity gone
  });
});
