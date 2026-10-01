import { DEFAULT_SETTINGS, type ShopSettings } from '@loyalty/ledger';
import type { Db } from './db.js';

export interface SettingsStore {
  /** Returns stored settings, or defaults for a shop with no row yet. */
  get(shopDomain: string): Promise<ShopSettings>;
  upsert(
    shopDomain: string,
    patch: Partial<Pick<ShopSettings, 'earnRate' | 'redemptionRate' | 'minRedemption'>>,
  ): Promise<ShopSettings>;
  markUninstalled(shopDomain: string, at: Date): Promise<void>;
  /** Irreversible tenant erasure for shop/redact. */
  purgeShop(shopDomain: string): Promise<void>;
}

const defaults = (shopDomain: string): ShopSettings => ({
  shopDomain,
  ...DEFAULT_SETTINGS,
  installedAt: new Date(0),
});

export class InMemorySettingsStore implements SettingsStore {
  private settings = new Map<string, ShopSettings>();

  async get(shopDomain: string): Promise<ShopSettings> {
    return this.settings.get(shopDomain) ?? defaults(shopDomain);
  }

  async upsert(
    shopDomain: string,
    patch: Partial<Pick<ShopSettings, 'earnRate' | 'redemptionRate' | 'minRedemption'>>,
  ): Promise<ShopSettings> {
    const current = this.settings.get(shopDomain) ?? { ...defaults(shopDomain), installedAt: new Date() };
    const next = { ...current, ...patch };
    this.settings.set(shopDomain, next);
    return next;
  }

  async markUninstalled(shopDomain: string, at: Date): Promise<void> {
    const current = await this.get(shopDomain);
    this.settings.set(shopDomain, { ...current, uninstalledAt: at });
  }

  async purgeShop(shopDomain: string): Promise<void> {
    this.settings.delete(shopDomain);
  }
}

export class PgSettingsStore implements SettingsStore {
  constructor(private readonly db: Db) {}

  async get(shopDomain: string): Promise<ShopSettings> {
    const { rows } = await this.db.query('select * from shop_settings where shop_domain = $1', [
      shopDomain,
    ]);
    if (!rows[0]) return defaults(shopDomain);
    return rowToSettings(rows[0]);
  }

  async upsert(
    shopDomain: string,
    patch: Partial<Pick<ShopSettings, 'earnRate' | 'redemptionRate' | 'minRedemption'>>,
  ): Promise<ShopSettings> {
    const { rows } = await this.db.query(
      `insert into shop_settings (shop_domain, earn_rate, redemption_rate, min_redemption)
       values ($1,
               coalesce($2::numeric, 1),
               coalesce($3::numeric, 100),
               coalesce($4::int, 100))
       on conflict (shop_domain) do update set
         earn_rate       = coalesce($2::numeric, shop_settings.earn_rate),
         redemption_rate = coalesce($3::numeric, shop_settings.redemption_rate),
         min_redemption  = coalesce($4::int, shop_settings.min_redemption),
         uninstalled_at  = null
       returning *`,
      [shopDomain, patch.earnRate ?? null, patch.redemptionRate ?? null, patch.minRedemption ?? null],
    );
    return rowToSettings(rows[0]);
  }

  async markUninstalled(shopDomain: string, at: Date): Promise<void> {
    await this.db.query(
      `insert into shop_settings (shop_domain, uninstalled_at) values ($1, $2)
       on conflict (shop_domain) do update set uninstalled_at = $2`,
      [shopDomain, at],
    );
  }

  async purgeShop(shopDomain: string): Promise<void> {
    // shop/redact: full tenant erasure (TECHNICAL-SPEC §2).
    await this.db.query('delete from points_ledger_entry where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from redemption_attempt where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from webhook_receipt where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from reconciliation_run where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from shop_settings where shop_domain = $1', [shopDomain]);
  }
}

function rowToSettings(row: Record<string, unknown>): ShopSettings {
  return {
    shopDomain: row['shop_domain'] as string,
    earnRate: String(row['earn_rate']),
    redemptionRate: String(row['redemption_rate']),
    minRedemption: Number(row['min_redemption']),
    installedAt: new Date(row['installed_at'] as string),
    ...(row['uninstalled_at'] != null
      ? { uninstalledAt: new Date(row['uninstalled_at'] as string) }
      : {}),
  };
}
