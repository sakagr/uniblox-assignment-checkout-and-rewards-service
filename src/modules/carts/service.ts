import type pg from 'pg';
import { Errors } from '../../domain/errors.js';
import { calculateTotals, paise } from '../../domain/money.js';

/** Locks the cart row (first in the D9 lock order) and requires it to be OPEN. */
async function lockOpenCart(client: pg.PoolClient, cartId: string): Promise<void> {
  const { rows } = await client.query<{ status: string }>(
    'SELECT status FROM carts WHERE id = $1 FOR UPDATE',
    [cartId],
  );
  if (rows.length === 0) throw Errors.cartNotFound();
  if (rows[0]!.status !== 'OPEN') throw Errors.cartAlreadyCheckedOut();
}

/**
 * Bumps the version unconditionally. Callers call it only when the preceding item statement
 * changed a row (`rowCount > 0`), which is what keeps a no-op edit from bumping it (I12).
 */
async function bumpVersion(client: pg.PoolClient, cartId: string): Promise<void> {
  await client.query('UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1', [cartId]);
}

export async function createCart(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>('INSERT INTO carts DEFAULT VALUES RETURNING id');
  return rows[0]!.id;
}

/** SPECIFICATIONS §6.1. Sets an absolute quantity; 0 removes the line. */
export async function setItemQuantity(
  client: pg.PoolClient,
  cartId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  await lockOpenCart(client, cartId);

  // Soft check, no lock: stock is only authoritative at confirm (D3).
  const product = await client.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [productId]);
  if (product.rows.length === 0) throw Errors.productNotFound();
  const available = product.rows[0]!.stock;
  if (quantity > available) {
    throw Errors.insufficientStock([{ productId, requested: quantity, available }]);
  }

  const result =
    quantity > 0
      ? await client.query(
          `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
           ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity
           WHERE cart_items.quantity <> EXCLUDED.quantity`,
          [cartId, productId, quantity],
        )
      : await client.query('DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2', [cartId, productId]);

  if ((result.rowCount ?? 0) > 0) await bumpVersion(client, cartId);
}

export async function removeItem(client: pg.PoolClient, cartId: string, productId: string): Promise<void> {
  await lockOpenCart(client, cartId);
  const result = await client.query('DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2', [
    cartId,
    productId,
  ]);
  if ((result.rowCount ?? 0) > 0) await bumpVersion(client, cartId);
}

export interface CartItemRow {
  product_id: string;
  quantity: number;
  name: string;
  unit_price_paise: number;
  stock: number;
}

/** The cart's lines with the products' current name, price and stock, ordered by product id. */
export async function loadCartItems(client: pg.PoolClient, cartId: string): Promise<CartItemRow[]> {
  const { rows } = await client.query<CartItemRow>(
    `SELECT ci.product_id, ci.quantity, p.name, p.unit_price_paise, p.stock
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1 ORDER BY ci.product_id`,
    [cartId],
  );
  return rows;
}

export async function loadCartView(client: pg.PoolClient, cartId: string) {
  const cart = await client.query<{ id: string; status: 'OPEN' | 'CHECKED_OUT'; version: number; order_id: string | null }>(
    `SELECT c.id, c.status, c.version, o.id AS order_id
       FROM carts c LEFT JOIN orders o ON o.cart_id = c.id
      WHERE c.id = $1`,
    [cartId],
  );
  if (cart.rows.length === 0) throw Errors.cartNotFound();
  const header = cart.rows[0]!;

  const items = await loadCartItems(client, cartId);

  // Current prices, not snapshots (DECISIONS: cart shows live price and stock).
  const totals = calculateTotals(
    items.map((row) => ({
      productId: row.product_id,
      name: row.name,
      unitPricePaise: paise(row.unit_price_paise),
      quantity: row.quantity,
      availableStock: row.stock,
    })),
    null,
  );

  return {
    id: header.id,
    status: header.status,
    version: header.version,
    orderId: header.order_id,
    lines: totals.lines.map((line) => ({
      ...line,
      sufficientStock: line.quantity <= line.availableStock,
    })),
    subtotalPaise: totals.subtotalPaise,
    currency: 'INR' as const,
  };
}
