# SPECIFICATIONS.md

Technical specification for the Checkout and Rewards Service. The rationale behind every choice lives in [`DECISIONS.md`](./DECISIONS.md). This file is the contract the implementation follows.

**Stack:**
- TypeScript, Node 20+
- Fastify, with TypeBox schemas and `@fastify/swagger`
- PostgreSQL 16 via docker-compose, accessed with `pg` (no ORM)

---

## 1. Configuration

| Env var | Default | Validation | Meaning |
|---|---|---|---|
| `DATABASE_URL` | `postgres://app:app@localhost:5432/checkout` | required | Main database |
| `TEST_DATABASE_URL` | `postgres://app:app@localhost:5432/checkout_test` | tests only | Test database (reset per test file) |
| `PORT` | `3000` | integer | HTTP port |
| `COUPON_EVERY_N_ORDERS` | `5` | integer ≥ 1 | `n`: a coupon becomes available at every nth placed order |
| `COUPON_PERCENT` | `10` | integer 1..100 | `x`: discount percent for newly generated coupons |
| `AUTO_GENERATE_COUPONS` | `true` | boolean | Generate the milestone coupon inside the nth order's checkout |
| `PG_POOL_MAX` | `20` | integer | Pool size. Must be ≥ the test concurrency so that requests genuinely overlap. |

Invalid configuration fails fast at startup. `n` and `x` are fixed per deployment (DECISIONS §2).

---

## 2. Domain model

```
products 1─* cart_items *─1 carts 1─* checkout_quotes 1─* quote_lines
                              │              │
                              │ 1            │ 1
                              └──── orders ──┘ (orders.cart_id UNIQUE, orders.quote_id UNIQUE)
                                     │ 1
                                     ├─* order_lines
                                     │
coupons ── milestone_order_id ──────►│ (the order that earned it)
        ── redeemed_order_id  ──────►│ (the order that spent it; FK deferred)

store_stats (single row: placed_orders counter)
```

**State transitions**
- Cart: `OPEN → CHECKED_OUT`. This is terminal and happens only inside the confirm transaction.
- Coupon: `AVAILABLE` (`redeemed_order_id IS NULL`) `→ REDEEMED`. This is terminal and happens only inside the confirm transaction.
- Quote: immutable once created. It is "consumed" when an order references it, and "stale" when the cart version or a product price no longer matches.
- Order: immutable once created.

---

## 3. DDL

File: `migrations/001_schema.sql`.

```sql
BEGIN;

-- ─────────────────────────────────────────────────────────────
-- Products
-- ─────────────────────────────────────────────────────────────
CREATE TABLE products (
  id                text        PRIMARY KEY CHECK (id ~ '^sku-[a-z0-9-]+$'),
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  unit_price_paise  bigint      NOT NULL CHECK (unit_price_paise > 0),
  stock             integer     NOT NULL CHECK (stock >= 0),                      -- I1
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Carts
-- ─────────────────────────────────────────────────────────────
CREATE TABLE carts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  version     integer     NOT NULL DEFAULT 0 CHECK (version >= 0),               -- I12: bumped on every real item change
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  cart_id     uuid        NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id  text        NOT NULL REFERENCES products(id),                      -- I11
  quantity    integer     NOT NULL CHECK (quantity BETWEEN 1 AND 1000),          -- I11
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

-- ─────────────────────────────────────────────────────────────
-- Coupons (FKs to orders are added at the end: circular reference)
-- Crockford base32 alphabet: 0-9 A-H J K M N P-T V-Z (no I, L, O, U)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE coupons (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text        NOT NULL UNIQUE CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  percent             smallint    NOT NULL CHECK (percent BETWEEN 1 AND 100),    -- snapshot of x at generation
  milestone           integer     NOT NULL UNIQUE CHECK (milestone > 0),         -- I6: one coupon per milestone
  milestone_order_id  uuid        NOT NULL UNIQUE,                               -- order with placement_number = milestone * n
  source              text        NOT NULL CHECK (source IN ('AUTO', 'ADMIN')),
  redeemed_order_id   uuid        UNIQUE,                                        -- I5 backstop
  redeemed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((redeemed_order_id IS NULL) = (redeemed_at IS NULL)),
  CHECK (redeemed_order_id IS DISTINCT FROM milestone_order_id)                  -- an order cannot spend the coupon it earned
);

-- ─────────────────────────────────────────────────────────────
-- Checkout quotes
-- ─────────────────────────────────────────────────────────────
CREATE TABLE checkout_quotes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id         uuid        NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  cart_version    integer     NOT NULL,
  coupon_id       uuid        REFERENCES coupons(id),
  coupon_percent  smallint    CHECK (coupon_percent BETWEEN 1 AND 100),
  subtotal_paise  bigint      NOT NULL CHECK (subtotal_paise > 0),
  discount_paise  bigint      NOT NULL CHECK (discount_paise >= 0 AND discount_paise <= subtotal_paise),
  total_paise     bigint      NOT NULL CHECK (total_paise = subtotal_paise - discount_paise),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((coupon_id IS NULL) = (coupon_percent IS NULL)),
  CHECK (coupon_id IS NOT NULL OR discount_paise = 0),
  UNIQUE (id, cart_id)                                                           -- target for orders' composite FK
);
CREATE INDEX checkout_quotes_cart_idx ON checkout_quotes (cart_id);

CREATE TABLE quote_lines (
  quote_id          uuid    NOT NULL REFERENCES checkout_quotes(id) ON DELETE CASCADE,
  product_id        text    NOT NULL REFERENCES products(id),
  product_name      text    NOT NULL,
  unit_price_paise  bigint  NOT NULL CHECK (unit_price_paise > 0),
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  line_total_paise  bigint  NOT NULL CHECK (line_total_paise = unit_price_paise * quantity),
  PRIMARY KEY (quote_id, product_id)
);

-- ─────────────────────────────────────────────────────────────
-- Orders (insert-only; I7)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                uuid        PRIMARY KEY,                                     -- generated by the app before coupon redeem
  cart_id           uuid        NOT NULL UNIQUE REFERENCES carts(id),            -- I3 / idempotency key
  quote_id          uuid        NOT NULL UNIQUE,
  placement_number  integer     NOT NULL UNIQUE CHECK (placement_number > 0),    -- I9
  subtotal_paise    bigint      NOT NULL CHECK (subtotal_paise > 0),
  coupon_code       text,                                                        -- snapshot, not FK (authority is coupons.redeemed_order_id)
  coupon_percent    smallint    CHECK (coupon_percent BETWEEN 1 AND 100),
  discount_paise    bigint      NOT NULL CHECK (discount_paise >= 0 AND discount_paise <= subtotal_paise),  -- I8
  total_paise       bigint      NOT NULL CHECK (total_paise = subtotal_paise - discount_paise),             -- I8
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((coupon_code IS NULL) = (coupon_percent IS NULL)),
  CHECK (coupon_code IS NOT NULL OR discount_paise = 0),
  FOREIGN KEY (quote_id, cart_id) REFERENCES checkout_quotes (id, cart_id)      -- the quote must belong to this cart
);

CREATE TABLE order_lines (
  order_id          uuid    NOT NULL REFERENCES orders(id),
  product_id        text    NOT NULL REFERENCES products(id),
  product_name      text    NOT NULL,                                            -- snapshot
  unit_price_paise  bigint  NOT NULL CHECK (unit_price_paise > 0),               -- snapshot
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  line_total_paise  bigint  NOT NULL CHECK (line_total_paise = unit_price_paise * quantity),  -- I8
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX order_lines_product_idx ON order_lines (product_id);

-- ─────────────────────────────────────────────────────────────
-- Placement counter (single row; I9)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE store_stats (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),                    -- enforces exactly one row
  placed_orders  integer NOT NULL DEFAULT 0 CHECK (placed_orders >= 0)
);
INSERT INTO store_stats DEFAULT VALUES;

-- ─────────────────────────────────────────────────────────────
-- Coupon → order FKs (added last to break the circular dependency)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE coupons
  ADD CONSTRAINT coupons_redeemed_order_fk
  FOREIGN KEY (redeemed_order_id) REFERENCES orders(id)
  DEFERRABLE INITIALLY DEFERRED;                                                 -- coupon is redeemed before the order row exists (D4)

ALTER TABLE coupons
  ADD CONSTRAINT coupons_milestone_order_fk
  FOREIGN KEY (milestone_order_id) REFERENCES orders(id);

COMMIT;
```

**Notes on the schema**
- `subtotal = Σ line_total` (I8) spans rows, so a `CHECK` can't express it. It is enforced by `calculateTotals()` and by the invariant checker in the tests. A deferred constraint trigger is possible, but is deferred.
- `orders.coupon_code` is a snapshot rather than an FK. Redemption has a single source of truth, `coupons.redeemed_order_id`. The tests reconcile the two: the number of orders with a coupon equals the number of redeemed coupons.
- The composite FK `(quote_id, cart_id)` guarantees at the DB level that an order is built from a quote of the same cart.
- `gen_random_uuid()` is built into PostgreSQL 13 and later, so no extension is needed.

---

## 4. Seed data

File: `migrations/002_seed.sql`.

```sql
INSERT INTO products (id, name, unit_price_paise, stock) VALUES
  ('sku-tshirt',          'Cotton T-Shirt',         49900, 100),
  ('sku-mug',             'Ceramic Mug',            29900,  50),
  ('sku-notebook',        'A5 Notebook',            19900, 200),
  ('sku-hoodie',          'Fleece Hoodie',         149900,  25),
  ('sku-sticker-pack',    'Sticker Pack',            9900, 500),
  ('sku-limited-sneaker', 'Limited Edition Sneaker', 899900,  2);   -- limited inventory
```

Migrations are plain SQL files, applied in order by `npm run db:migrate`, a small script that records applied files in a `schema_migrations` table. `npm run db:reset` drops and re-applies everything.

---

## 5. API

### 5.1 Conventions

- JSON with camelCase. Every money field ends in `Paise` and is accompanied by `"currency": "INR"`.
- IDs:
  - Products use readable IDs (`sku-*`).
  - Carts, quotes and orders use UUIDs.
  - Coupons are identified by their code.
- Coupon codes in requests are trimmed and uppercased before lookup.
- Every error uses the envelope `{"error": {"code", "message", "details"}}`. The codes are listed in §5.4.
- Admin-only endpoints sit under `/admin/*`. There is no authentication.
- `GET /docs` serves Swagger UI. `GET /docs/json` serves the OpenAPI document. `GET /health` returns `200 {"status":"ok"}` after a `SELECT 1`.

### 5.2 Shared response shapes

**CartView**
```json
{
  "id": "6f1c…", "status": "OPEN", "version": 3, "orderId": null,
  "lines": [{
    "productId": "sku-mug", "name": "Ceramic Mug",
    "unitPricePaise": 29900, "quantity": 2, "lineTotalPaise": 59800,
    "availableStock": 50, "sufficientStock": true
  }],
  "subtotalPaise": 59800, "currency": "INR"
}
```
Prices and stock are always the **current** values. `orderId` is set once the cart is `CHECKED_OUT`.

**Quote**
```json
{
  "quoteId": "b2e0…", "cartId": "6f1c…", "cartVersion": 3,
  "lines": [{"productId", "name", "unitPricePaise", "quantity", "lineTotalPaise", "availableStock", "sufficientStock"}],
  "subtotalPaise": 59800,
  "couponApplied": {"code": "7KQ2M9XHV3PA", "percent": 10},
  "discountPaise": 5980, "totalPaise": 53820, "currency": "INR",
  "createdAt": "2026-10-29T12:00:00.000Z"
}
```
`couponApplied` is `null` when no coupon was given.

**Order**
```json
{
  "id": "a91d…", "cartId": "6f1c…", "quoteId": "b2e0…", "placementNumber": 10,
  "lines": [{"productId", "name", "unitPricePaise", "quantity", "lineTotalPaise"}],
  "subtotalPaise": 59800,
  "couponApplied": {"code": "7KQ2M9XHV3PA", "percent": 10},
  "discountPaise": 5980, "totalPaise": 53820,
  "earnedCoupon": {"code": "P4ZR8W1NTQ6C", "percent": 10, "milestone": 2},
  "currency": "INR", "createdAt": "…"
}
```
`couponApplied` and `earnedCoupon` are `null` when they don't apply. Every field is a snapshot, so the response never changes.

**Coupon (admin)**
```json
{
  "code": "P4ZR8W1NTQ6C", "percent": 10, "milestone": 2,
  "milestoneOrderId": "a91d…", "source": "AUTO",
  "status": "AVAILABLE", "redeemedOrderId": null,
  "createdAt": "…", "redeemedAt": null
}
```

### 5.3 Endpoints

#### `GET /products`
- **Response:** `200` with `[{id, name, unitPricePaise, stock, currency}]`, ordered by `id`.

#### `POST /carts`
- **Request:** no body.
- **Response:** `201` with a CartView (empty `lines`, `subtotalPaise: 0`) and the header `Location: /carts/{id}`.

#### `GET /carts/{cartId}`
- **Response:** `200` with a CartView.
- **Errors:** 400 `VALIDATION_ERROR` (bad UUID), 404 `CART_NOT_FOUND`.

#### `PUT /carts/{cartId}/items/{productId}`
- **Request:** `{"quantity": <integer 0..1000>}`. 0 removes the line.
- **Response:** `200` with the updated CartView.
- **Errors:**
  - 400 `VALIDATION_ERROR`
  - 404 `CART_NOT_FOUND`
  - 404 `PRODUCT_NOT_FOUND`
  - 409 `CART_ALREADY_CHECKED_OUT`
  - 409 `INSUFFICIENT_STOCK`, a soft check with details `[{productId, requested, available}]`
- **Semantics:**
  - Sets an absolute quantity, so the call is idempotent.
  - `version` increments only if the line actually changed. Re-sending the same quantity does not invalidate quotes.

#### `DELETE /carts/{cartId}/items/{productId}`
- **Response:** `200` with the CartView. Removing an absent line is a no-op that still returns 200, and the version does not change.
- **Errors:** 400 `VALIDATION_ERROR`, 404 `CART_NOT_FOUND`, 409 `CART_ALREADY_CHECKED_OUT`.

#### `POST /carts/{cartId}/checkout/quote`
- **Request:** `{"couponCode": "…"}`. The field is optional, and an empty body `{}` is allowed.
- **Response:** `201` with a Quote.
- **Errors:**
  - 400 `VALIDATION_ERROR`
  - 404 `CART_NOT_FOUND`
  - 409 `CART_ALREADY_CHECKED_OUT`
  - 422 `EMPTY_CART`
  - 422 `COUPON_INVALID`
  - 409 `COUPON_ALREADY_REDEEMED`
  - 409 `INSUFFICIENT_STOCK`
- **Semantics:** no stock, coupon or cart mutation; it only inserts the quote rows. Nothing is reserved.

#### `POST /carts/{cartId}/checkout`
- **Request:** `{"quoteId": "<uuid>"}`.
- **Response:**
  - `201` with `{"order": Order, "earnedCoupon": {code, percent, milestone} | null}` for a new order.
  - `200` with the **same body** and the header `Idempotent-Replayed: true` when this quote already produced the order.
- **Errors:**
  - 400 `VALIDATION_ERROR`
  - 404 `CART_NOT_FOUND`
  - 404 `QUOTE_NOT_FOUND` (also returned when the quote belongs to another cart)
  - 409 `CART_ALREADY_CHECKED_OUT` (checked out with a different quote)
  - 409 `QUOTE_STALE`, with details `{reason: "CART_CHANGED"}` or `{reason: "PRICE_CHANGED", changes: [{productId, quotedPaise, currentPaise}]}`
  - 409 `COUPON_ALREADY_REDEEMED`
  - 409 `INSUFFICIENT_STOCK`
  - 503 `TRANSIENT_CONFLICT`
- **Semantics:** on any error nothing changes. The cart stays `OPEN` and the coupon stays available.

#### `GET /orders/{orderId}`
- **Response:** `200` with an Order.
- **Errors:** 400 `VALIDATION_ERROR`, 404 `ORDER_NOT_FOUND`.

#### `POST /admin/coupons` (admin)
- **Request:** no body.
- **Response:** `201` with `{"coupon": Coupon, "pendingMilestones": <int>}`.
- **Errors:** 409 `NO_ELIGIBLE_MILESTONE`, with details `{placedOrders, rewardedMilestones, nextMilestoneAtOrder}`.
- **Semantics:** generates exactly one coupon, for the lowest reached milestone that has no coupon.

#### `GET /admin/coupons?status=AVAILABLE|REDEEMED` (admin)
- **Response:** `200` with `[Coupon]`, ordered by `milestone`.

#### `GET /admin/orders` (admin)
- **Response:** `200` with `[{id, placementNumber, subtotalPaise, discountPaise, totalPaise, couponCode, createdAt, currency}]`, ordered by `placementNumber`.

#### `GET /admin/report` (admin)
- **Response:** `200` with:
```json
{
  "placedOrders": 12,
  "productsSold": [{"productId": "sku-mug", "name": "Ceramic Mug", "quantity": 7}],
  "grossRevenuePaise": 1234500,
  "totalDiscountPaise": 12345,
  "netRevenuePaise": 1222155,
  "coupons": {"generated": 2, "available": 1, "redeemed": 1},
  "currency": "INR",
  "generatedAt": "…"
}
```
- **Semantics:**
  - `productsSold` includes every product, with 0 for unsold ones.
  - `grossRevenuePaise` = Σ `orders.subtotal_paise`, `totalDiscountPaise` = Σ `orders.discount_paise`, and `netRevenuePaise` = Σ `orders.total_paise`. Because each order satisfies `total = subtotal − discount`, `net = gross − discount` holds by construction.
  - `coupons.generated = available + redeemed`.
  - The report is read-only.

### 5.4 Error codes

| HTTP | Code | Raised by |
|---|---|---|
| 400 | `VALIDATION_ERROR` | All endpoints (schema validation; details are field errors) |
| 404 | `CART_NOT_FOUND` | Cart, item, quote and checkout endpoints |
| 404 | `PRODUCT_NOT_FOUND` | `PUT` item |
| 404 | `QUOTE_NOT_FOUND` | Checkout |
| 404 | `ORDER_NOT_FOUND` | `GET /orders/{id}` |
| 409 | `CART_ALREADY_CHECKED_OUT` | Item endpoints, quote, checkout (with a different quote) |
| 409 | `INSUFFICIENT_STOCK` | `PUT` item (soft), quote (advisory), checkout (authoritative) |
| 409 | `COUPON_ALREADY_REDEEMED` | Quote, checkout |
| 409 | `QUOTE_STALE` | Checkout |
| 409 | `NO_ELIGIBLE_MILESTONE` | `POST /admin/coupons` |
| 422 | `EMPTY_CART` | Quote |
| 422 | `COUPON_INVALID` | Quote |
| 503 | `TRANSIENT_CONFLICT` | Any write: Postgres error `40P01`, `40001` or `55P03` (lock timeout), or a coupon-code collision (`23505` on `coupons.code`) |
| 500 | `INTERNAL_ERROR` | Anything unmapped. No stack trace in the response; it is logged with the request ID. |

---

## 6. Critical SQL paths

All write paths run through `withTransaction(fn, {isolation})`, which checks out a single client and runs `BEGIN` / `COMMIT` / `ROLLBACK`, releasing the client in `finally`. Inside a transaction, never use `pool.query`.

**Global lock order (D9):** cart → coupon → products (by id) → store_stats.

### 6.1 Set item quantity (`PUT` / `DELETE`), READ COMMITTED

```sql
-- 1. Lock the cart; this also serializes edits against a concurrent confirm
SELECT status FROM carts WHERE id = $cartId FOR UPDATE;
--    no row → CART_NOT_FOUND; status <> 'OPEN' → CART_ALREADY_CHECKED_OUT

-- 2. (PUT only) product existence + soft stock check, no lock
SELECT stock FROM products WHERE id = $productId;
--    no row → PRODUCT_NOT_FOUND; $qty > stock → INSUFFICIENT_STOCK

-- 3a. quantity > 0: upsert only if it actually changes
INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($cartId, $productId, $qty)
ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity
WHERE cart_items.quantity <> EXCLUDED.quantity;
-- 3b. quantity = 0 or DELETE
DELETE FROM cart_items WHERE cart_id = $cartId AND product_id = $productId;

-- 4. bump the version only if step 3 affected a row
UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $cartId;
```

### 6.2 Quote, REPEATABLE READ

REPEATABLE READ gives one snapshot, so the cart version and its items are read consistently. Under READ COMMITTED, an edit committing between the two reads could pair version *v+1* with the items of *v*, and that quote would then wrongly pass the confirm version check.

```sql
SELECT status, version FROM carts WHERE id = $cartId;
SELECT ci.product_id, ci.quantity, p.name, p.unit_price_paise, p.stock
  FROM cart_items ci JOIN products p ON p.id = ci.product_id
 WHERE ci.cart_id = $cartId ORDER BY ci.product_id;
SELECT id, percent, redeemed_order_id FROM coupons WHERE code = $code;   -- if a code is given
-- validate, then calculateTotals(), then:
INSERT INTO checkout_quotes (...) VALUES (...) RETURNING id, created_at;
INSERT INTO quote_lines (...) SELECT * FROM unnest(...);
```

A serialization failure here is not expected, because the transaction only inserts new rows. If one occurs, it maps to 503 like any other.

### 6.3 Confirm checkout, READ COMMITTED

```sql
-- 0. quote must exist and belong to this cart
SELECT * FROM checkout_quotes WHERE id = $quoteId AND cart_id = $cartId;   -- none → QUOTE_NOT_FOUND
SELECT * FROM quote_lines WHERE quote_id = $quoteId ORDER BY product_id;

-- 1. lock cart
SELECT status, version FROM carts WHERE id = $cartId FOR UPDATE;
--    CHECKED_OUT: SELECT * FROM orders WHERE cart_id = $cartId
--                 → quote_id = $quoteId ? replay (200) : CART_ALREADY_CHECKED_OUT
--    version <> quote.cart_version → QUOTE_STALE (CART_CHANGED)

-- 2. redeem coupon (if quote.coupon_id); $orderId generated in app (crypto.randomUUID)
UPDATE coupons SET redeemed_order_id = $orderId, redeemed_at = now()
 WHERE id = $couponId AND redeemed_order_id IS NULL;
--    rowCount = 0 → COUPON_ALREADY_REDEEMED

-- 3. lock products in id order, compare prices with the quote
SELECT id, name, unit_price_paise, stock FROM products
 WHERE id = ANY($productIds) ORDER BY id FOR UPDATE;
--    any unit_price_paise <> quoted → QUOTE_STALE (PRICE_CHANGED, per-line diff)
--    any stock < qty → INSUFFICIENT_STOCK (all short lines in details)

-- 4. decrement (guarded even though rows are locked: belt and braces)
UPDATE products SET stock = stock - $qty, updated_at = now()
 WHERE id = $productId AND stock >= $qty;                     -- per line; rowCount must be 1

-- 5. totals: calculateTotals(lines, quote.coupon_percent); assert equal to the quote's totals

-- 6. counter (locked last; held until commit)
UPDATE store_stats SET placed_orders = placed_orders + 1 RETURNING placed_orders;

-- 7. write order + snapshot, close cart
INSERT INTO orders (id, cart_id, quote_id, placement_number, subtotal_paise,
                    coupon_code, coupon_percent, discount_paise, total_paise) VALUES (...);
INSERT INTO order_lines (...) SELECT * FROM unnest(...);
UPDATE carts SET status = 'CHECKED_OUT', updated_at = now() WHERE id = $cartId;

-- 8. milestone coupon (if AUTO_GENERATE_COUPONS and placement_number % n = 0)
INSERT INTO coupons (code, percent, milestone, milestone_order_id, source)
VALUES ($code, $x, $placementNumber / $n, $orderId, 'AUTO')
ON CONFLICT (milestone) DO NOTHING
RETURNING code, percent, milestone;

COMMIT;   -- deferred FK coupons.redeemed_order_id → orders checked here
```

Because the cart items are only modified under the cart lock (§6.1), the items read after step 1 match the quote whenever the versions match. The implementation still asserts that the product and quantity sets are equal, as a defensive check.

### 6.4 Admin coupon generation, READ COMMITTED

```sql
SELECT placed_orders FROM store_stats FOR UPDATE;            -- serializes with confirms; sees only committed orders
SELECT k FROM generate_series(1, $placed / $n) AS k          -- integer division
 WHERE NOT EXISTS (SELECT 1 FROM coupons c WHERE c.milestone = k)
 ORDER BY k LIMIT 1;                                          -- none → NO_ELIGIBLE_MILESTONE
SELECT id FROM orders WHERE placement_number = $k * $n;       -- always exists (gapless counter)
INSERT INTO coupons (code, percent, milestone, milestone_order_id, source)
VALUES ($code, $x, $k, $orderId, 'ADMIN') RETURNING *;
-- pendingMilestones = (placed / n) - (count of coupons)
```

### 6.5 Report, REPEATABLE READ READ ONLY

```sql
SELECT count(*) AS placed_orders,
       COALESCE(sum(subtotal_paise), 0) AS gross,
       COALESCE(sum(discount_paise), 0) AS discount,
       COALESCE(sum(total_paise), 0)    AS net
  FROM orders;

SELECT p.id, p.name, COALESCE(sum(ol.quantity), 0) AS quantity
  FROM products p LEFT JOIN order_lines ol ON ol.product_id = p.id
 GROUP BY p.id, p.name ORDER BY p.id;

SELECT count(*) AS generated,
       count(*) FILTER (WHERE redeemed_order_id IS NULL)     AS available,
       count(*) FILTER (WHERE redeemed_order_id IS NOT NULL) AS redeemed
  FROM coupons;
```

`sum()` and `count()` return `numeric` / `bigint`, which `pg` delivers as strings. They are converted through the single safe-integer parser (DECISIONS §5).

### 6.6 Coupon code generation

```ts
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, 32 symbols
const bytes = crypto.randomBytes(12);
const code = Array.from(bytes, b => ALPHABET[b & 31]).join(''); // 256 % 32 == 0, so no modulo bias; 60 bits
```

A collision (`23505` on `coupons.code`) is astronomically unlikely. If it does happen, it aborts the transaction and maps to 503. Confirm is idempotent, so a retry is safe.

---

## 7. Money

- **Representation:** all amounts are integer paise. In TypeScript they are a branded `Paise` type, created only through `paise(n)`, which asserts `Number.isSafeInteger(n) && n >= 0`.
- **Driver:** `pg.types.setTypeParser(20, parseSafeInt)` handles int8. `numeric` aggregates are cast to `bigint` in SQL, or parsed with the same function.
- **Calculation:** one pure function.
  ```ts
  calculateTotals(lines: {unitPricePaise: Paise; quantity: number}[], percent: number | null)
    → {lines: {..., lineTotalPaise}, subtotalPaise, discountPaise, totalPaise}
  // lineTotal = unitPrice * quantity
  // subtotal  = Σ lineTotal
  // discount  = percent ? Math.floor(subtotal * percent / 100) : 0
  // total     = subtotal - discount
  ```
- **Overflow headroom:** the largest product price × 1000 × the number of lines stays far below 2⁵³. `subtotal * percent` (≤ 100 × subtotal) is also checked with `Number.isSafeInteger`.

---

## 8. Project layout (suggested)

```
.
├── docker-compose.yml          # postgres:16-alpine, creates checkout + checkout_test DBs
├── migrations/
│   ├── 001_schema.sql
│   └── 002_seed.sql
├── src/
│   ├── app.ts                  # buildApp(config, pool): Fastify instance (used by server + tests)
│   ├── server.ts               # entrypoint
│   ├── config.ts               # env parsing + validation
│   ├── db/
│   │   ├── pool.ts             # pg pool + int8 parser
│   │   ├── tx.ts               # withTransaction + lock-order comment
│   │   └── migrate.ts
│   ├── domain/
│   │   ├── money.ts            # Paise, paise(), calculateTotals()
│   │   ├── coupon-code.ts
│   │   └── errors.ts           # DomainError subclasses with code + status
│   ├── modules/
│   │   ├── products/
│   │   ├── carts/              # routes, schemas, service (SQL)
│   │   ├── checkout/           # quote + confirm
│   │   ├── orders/
│   │   └── admin/              # coupons, orders, report
│   └── http/
│       └── error-handler.ts    # DomainError + pg errors → envelope
├── test/
│   ├── helpers.ts              # resetDb, seed, createCartWith(...), parallel(n, fn)
│   ├── money.test.ts
│   ├── cart.test.ts
│   ├── checkout.test.ts
│   ├── checkout.concurrency.test.ts
│   ├── coupons.test.ts
│   └── report.test.ts
├── README.md                   # setup, run, curl walkthrough
├── SPECIFICATIONS.md
└── DECISIONS.md
```

---

## 9. Test plan

All tests run against a real Postgres (`TEST_DATABASE_URL`), reset before each file. Concurrency tests fire requests with `Promise.all` over `app.inject()`, with `PG_POOL_MAX` at or above the fan-out so that the transactions genuinely overlap.

| ID | Scenario | Asserts | Invariants |
|---|---|---|---|
| T1 | `calculateTotals` table tests: no coupon, 10%, 100%, floor rounding (e.g. 999 paise at 10% gives a 99 discount), safe-integer guard | exact integers; total ≥ 0 | I8 |
| T2 | Invalid cart input: unknown product, qty −1, 1.5, 1001, string; qty above stock | 400 / 404 / 409 with the correct code; cart unchanged | I11 |
| T3 | Qty 0 removes; repeated PUT of the same qty does not bump the version | lines and version | I11, I12 |
| T4 | **Parallel confirm, same quote ×10** | exactly one 201, nine 200 with `Idempotent-Replayed`, same order ID; stock decremented once; counter +1 | I2, I3, I9 |
| T5 | **Oversell race:** `sku-limited-sneaker` (stock 2) in 10 carts, quote all, confirm all in parallel | exactly 2 × 201 and 8 × 409 `INSUFFICIENT_STOCK`; final stock 0; Σ sold = 2 | I1, I2 |
| T6 | **Coupon race:** one coupon in quotes for 5 carts, confirmed in parallel | exactly one order with a discount; the rest get 409 `COUPON_ALREADY_REDEEMED` and stay `OPEN` | I5 |
| T7 | Coupon survives a failed checkout: quote with a coupon, drain stock, confirm | 409 `INSUFFICIENT_STOCK`; coupon still `AVAILABLE`; it redeems successfully on another cart | I5 |
| T8 | Stale quote by price: quote, update the price in the DB (up, then separately down), confirm | 409 `QUOTE_STALE` (`PRICE_CHANGED`, diff); stock, coupon and counter untouched; re-quote and confirm succeeds at the new price | I12, I7 |
| T9 | Stale quote by cart edit: quote, change qty, confirm | 409 `QUOTE_STALE` (`CART_CHANGED`) | I12 |
| T10 | Order history survives a price change: place an order, change the price, `GET /orders/{id}` | identical snapshot | I7 |
| T11 | Auto coupon: with n = 3, place 3 orders | the third order's response has `earnedCoupon`; `GET /orders` shows it; admin generate returns 409 `NO_ELIGIBLE_MILESTONE` | I6 |
| T12 | **Admin generate race** (auto off, n = 2, 4 orders placed): 10 parallel `POST /admin/coupons` | exactly 2 × 201 (milestones 1 and 2) and 8 × 409; no duplicate milestones | I6 |
| T13 | **Milestone under concurrency** (auto on, n = 5): 20 carts confirmed in parallel | placement numbers exactly 1..20 with no gaps; exactly 4 coupons, linked to orders 5, 10, 15 and 20 | I6, I9 |
| T14 | Report reconciliation after a mixed run (including T5–T7 style failures) | report figures equal values recomputed from `GET /admin/orders` and `/admin/coupons`; two report calls return the same body (excluding `generatedAt`); no row counts change | I10 |
| T15 | Invariant checker helper, run at the end of every concurrency test | `stock + Σ sold = seed stock` per product; orders with a coupon = redeemed coupons; `subtotal = Σ line_total` per order; counter = order count | I1–I9 |

---

## 10. Out of scope

See DECISIONS §7. In short: auth, frontend, payments, reservations, quote expiry, customer-bound coupons, rate limiting, admin product management, pagination and observability.