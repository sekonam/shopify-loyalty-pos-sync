import { DEFAULT_SETTINGS, type ShopSettings } from '@loyalty/ledger';
import type { Db } from './db.js';

export type SettingsPatch = Partial<
  Pick<ShopSettings, 'earnRate' | 'redemptionRate' | 'minRedemption' | 'currency'>
>;

export interface SettingsStore {
  /** Returns stored settings, or defaults for a shop with no row yet. */
  get(shopDomain: string): Promise<ShopSettings>;
  upsert(shopDomain: string, patch: SettingsPatch): Promise<ShopSettings>;
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

  async upsert(shopDomain: string, patch: SettingsPatch): Promise<ShopSettings> {
    const current =
      this.settings.get(shopDomain) ?? { ...defaults(shopDomain), installedAt: new Date() };
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

  async upsert(shopDomain: string, patch: SettingsPatch): Promise<ShopSettings> {
    // Note: an upsert never clears uninstalled_at — resurrecting a tenant is
    // an explicit (re)install-flow concern, not a side effect of a write.
    const { rows } = await this.db.query(
      `insert into shop_settings (shop_domain, earn_rate, redemption_rate, min_redemption, currency)
       values ($1,
               coalesce($2::numeric, 1),
               coalesce($3::numeric, 100),
               coalesce($4::int, 100),
               $5::text)
       on conflict (shop_domain) do update set
         earn_rate       = coalesce($2::numeric, shop_settings.earn_rate),
         redemption_rate = coalesce($3::numeric, shop_settings.redemption_rate),
         min_redemption  = coalesce($4::int, shop_settings.min_redemption),
         currency        = coalesce($5::text, shop_settings.currency)
       returning *`,
      [
        shopDomain,
        patch.earnRate ?? null,
        patch.redemptionRate ?? null,
        patch.minRedemption ?? null,
        patch.currency ?? null,
      ],
    );
    return rowToSettings(rows[0]);
  }

  async markUninstalled(shopDomain: string, at: Date): Promise<void> {
    await this.db.query(
      `insert into shop_settings (shop_domain, uninstalled_at) values ($1, $2)
       on conflict (shop_domain) do update set uninstalled_at = $2`,
      [shopDomain, at],
    );
    // The Admin token is dead the moment the app is uninstalled; keeping it
    // would only let the reconciliation sweep fail (or worse, write) later.
    await this.db.query('delete from shop_token where shop_domain = $1', [shopDomain]);
  }

  async purgeShop(shopDomain: string): Promise<void> {
    // shop/redact: full tenant data erasure — credentials included.
    await this.db.query('delete from points_ledger_entry where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from redemption_attempt where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from webhook_receipt where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from reconciliation_run where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from shop_token where shop_domain = $1', [shopDomain]);
    await this.db.query('delete from shop_settings where shop_domain = $1', [shopDomain]);
  }
}

function rowToSettings(row: Record<string, unknown>): ShopSettings {
  return {
    shopDomain: row['shop_domain'] as string,
    earnRate: String(row['earn_rate']),
    redemptionRate: String(row['redemption_rate']),
    minRedemption: Number(row['min_redemption']),
    ...(row['currency'] != null ? { currency: row['currency'] as string } : {}),
    installedAt: new Date(row['installed_at'] as string),
    ...(row['uninstalled_at'] != null
      ? { uninstalledAt: new Date(row['uninstalled_at'] as string) }
      : {}),
  };
}
