/**
 * The product catalog the agent shops from.
 *
 * ADR-0013 rejected DummyJSON and FakeStoreAPI: they work and need no key, but
 * they price in USD, list US consumer goods, and carry NO MERCHANT CATEGORY
 * CODE. Our CATEGORY_BLOCKLIST rule keys on ISO 18245 MCCs, so a catalog
 * without them cannot exercise the rule at all.
 *
 * THE MCC COMES FROM THE MERCHANT, NEVER FROM THE PRODUCT. A merchant cannot
 * dodge a category block by relabelling a listing, because policy never reads
 * anything the merchant writes about the product.
 */
import type pg from 'pg';

export interface CatalogItem {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly unitPricePaise: number;
  readonly unit: string;
  readonly shelf: string;
  readonly merchantId: string;
  readonly merchantName: string;
  /** From the MERCHANT. The only category any rule reads. */
  readonly merchantMcc: string;
}

export interface CatalogQuery {
  readonly query?: string;
  /**
   * Restricts results to merchants the mandate permits.
   *
   * DENY BY DEFAULT: an empty array returns nothing, exactly as an empty
   * merchant allowlist blocks everything. `undefined` means "no restriction",
   * which is a different thing and must stay distinguishable - the same
   * distinction the mandate allowlist makes.
   */
  readonly merchantIds?: readonly string[];
  readonly maxPricePaise?: number;
  readonly limit?: number;
}

export interface CatalogProvider {
  readonly name: string;
  search(query: CatalogQuery): Promise<CatalogItem[]>;
  get(productId: string): Promise<CatalogItem | null>;
}

const COLUMNS = `
  p.id, p.sku, p.name, p.description, p.unit_price_paise, p.unit, p.shelf,
  p.merchant_id, m.display_name AS merchant_name, m.mcc AS merchant_mcc
`;

interface RawItem {
  id: string; sku: string; name: string; description: string;
  unit_price_paise: string | number; unit: string; shelf: string;
  merchant_id: string; merchant_name: string; merchant_mcc: string;
}

function toItem(row: RawItem): CatalogItem {
  return {
    productId: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    unitPricePaise: Number(row.unit_price_paise),
    unit: row.unit,
    shelf: row.shelf,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    merchantMcc: row.merchant_mcc,
  };
}

/** Reads the seeded `products` table. Offline, deterministic, no network. */
export class DatabaseCatalogProvider implements CatalogProvider {
  readonly name = 'seeded_catalog';

  constructor(private readonly pool: pg.Pool) {}

  async search(query: CatalogQuery): Promise<CatalogItem[]> {
    // Deny by default: an EMPTY allowlist returns nothing. `undefined` means no
    // restriction. Collapsing the two would turn a deny-by-default rule into
    // allow-by-default, which is the same bug the mandate repository guards
    // against when it reads a NULL allowlist.
    if (query.merchantIds !== undefined && query.merchantIds.length === 0) return [];

    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

    const result = await this.pool.query<RawItem>(
      `SELECT ${COLUMNS}
         FROM products p
         JOIN merchants m ON m.id = p.merchant_id
        WHERE p.in_stock = true
          AND m.status = 'active'
          AND ($1::text IS NULL OR
               p.name ILIKE '%' || $1 || '%' OR
               p.shelf ILIKE '%' || $1 || '%')
          AND ($2::text[] IS NULL OR p.merchant_id = ANY($2))
          AND ($3::bigint IS NULL OR p.unit_price_paise <= $3)
        ORDER BY p.unit_price_paise, p.name
        LIMIT $4`,
      [
        query.query ?? null,
        query.merchantIds === undefined ? null : [...query.merchantIds],
        query.maxPricePaise ?? null,
        limit,
      ],
    );

    return result.rows.map(toItem);
  }

  async get(productId: string): Promise<CatalogItem | null> {
    const result = await this.pool.query<RawItem>(
      `SELECT ${COLUMNS} FROM products p
         JOIN merchants m ON m.id = p.merchant_id
        WHERE p.id = $1`,
      [productId],
    );

    const row = result.rows[0];
    return row === undefined ? null : toItem(row);
  }
}
