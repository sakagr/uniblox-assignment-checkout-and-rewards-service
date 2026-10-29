# Checkout and Rewards Service

The backend for a checkout and rewards service. Customers build carts, get a checkout quote and confirm it to place an order. Every nth placed order makes an x% coupon available. The focus is **correctness under retries and concurrency**: no oversold stock, no double-redeemed coupon, no duplicate order on a retry.

- [SPECIFICATIONS.md](SPECIFICATIONS.md): the contract (config, DDL, API shapes, error codes, SQL for each critical path, test plan).
- [DECISIONS.md](DECISIONS.md): the rationale (invariants, chosen semantics, design decisions, what is deferred).
- Interactive API docs (Swagger UI): <http://localhost:3000/docs>. The OpenAPI document is at `/docs/json`.
- Assignment brief: <https://github.com/neustackapp/assignment/tree/main/be>

## Quick start (Docker only)

Only Docker (or OrbStack) is needed.

```bash
docker compose up -d --build --wait   # Postgres + the app; migrates and seeds on start
curl localhost:3000/health            # {"status":"ok"}
```

| Task | Command (npm alias) |
|---|---|
| Start | `docker compose up -d --build --wait` (`npm run up`) |
| Run the tests in the container | `docker compose run --rm --build app npm test` (`npm run test:docker`) |
| Stop, keep the data | `docker compose down` (`npm run down`) |
| Reset everything to a fresh seeded database | `docker compose down -v`, then start again |

Compose reads a `.env` next to `docker-compose.yml` for `COUPON_EVERY_N_ORDERS`, `COUPON_PERCENT`, `AUTO_GENERATE_COUPONS`, `APP_PORT` and `PG_PORT`. The container's database URLs always point at the `db` service, whatever `.env` says.

## Development (local Node)

Needs Node ≥ 20.12, Docker (for Postgres) and, for the walkthrough, `jq`.

```bash
npm ci
cp .env.example .env
npm run db:up        # Postgres only
npm run db:migrate   # the container does this on start; locally it is a separate step
npm run dev          # tsx watch, http://localhost:3000
```

- **Port clash:** with the app container running, `npm run dev` fails with `EADDRINUSE` on port 3000. Run `docker compose stop app` first, or move the container with `APP_PORT=3001` in `.env`.
- **Tests:** `npm run typecheck` and `npm test`. `npm run db:migrate:test` is **not** needed: every test file resets its own schema in `checkout_test` (verified by wiping that schema and running the suite).
- **Reset the dev database:** `npm run db:reset`.
- `checkout_test` is created only when the Postgres volume is first initialised. If it is missing, run `docker compose down -v` and start again.

## Configuration

Read from the environment (`.env` is loaded by `npm run dev` / `npm start`; variables already set win). Invalid values fail fast, naming the variable.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://app:app@localhost:5432/checkout` | Main database |
| `TEST_DATABASE_URL` | `postgres://app:app@localhost:5432/checkout_test` | Test database, reset per test file. Tests only |
| `PORT` | `3000` | HTTP port |
| `COUPON_EVERY_N_ORDERS` | `5` | n: a coupon becomes available at every nth placed order (integer ≥ 1) |
| `COUPON_PERCENT` | `10` | x: discount percent of newly generated coupons (integer 1..100) |
| `AUTO_GENERATE_COUPONS` | `true` | Generate the milestone coupon inside the nth order's checkout |
| `PG_POOL_MAX` | `20` | Postgres pool size. Keep it at or above the test fan-out so requests overlap |
| `PG_PORT` | `5432` | Host port for Postgres. Read only by `docker-compose.yml` |
| `APP_PORT` | `3000` | Host port for the app container. Read only by `docker-compose.yml` |

## Endpoints

| Method | Path | Purpose | Success |
|---|---|---|---|
| GET | `/health` | Liveness and database check | 200 |
| GET | `/docs`, `/docs/json` | Swagger UI and the OpenAPI document | 200 |
| GET | `/products` | List products | 200 |
| POST | `/carts` | Create an empty cart | 201 |
| GET | `/carts/{cartId}` | View a cart with current prices and stock | 200 |
| PUT | `/carts/{cartId}/items/{productId}` | Set the absolute quantity of a line (0 removes it) | 200 |
| DELETE | `/carts/{cartId}/items/{productId}` | Remove a line (an absent line is a no-op) | 200 |
| POST | `/carts/{cartId}/checkout/quote` | Price the cart, optionally with a coupon, and store the quote | 201 |
| POST | `/carts/{cartId}/checkout` | Place the order for a quote (idempotent per cart and quote) | 201, or 200 on a replay |
| GET | `/orders/{orderId}` | View a placed order (an immutable snapshot) | 200 |
| POST | `/admin/coupons` | **Admin only.** Generate the coupon for the lowest reached milestone that has none | 201 |
| GET | `/admin/coupons?status=AVAILABLE\|REDEEMED` | **Admin only.** List coupons by milestone | 200 |
| GET | `/admin/orders` | **Admin only.** List placed orders by placement number | 200 |
| GET | `/admin/report` | **Admin only.** Sales and coupon summary | 200 |

`/admin/*` has **no authentication, by design** ([DECISIONS §7](DECISIONS.md)). The brief does not ask for it, so those routes are only grouped and documented as admin-only.

Money is integer paise (`...Paise` fields, with `"currency": "INR"`). Every error uses the envelope `{"error": {"code", "message", "details"}}`; the codes are in [SPECIFICATIONS §5.4](SPECIFICATIONS.md) and per route in `/docs`.

## Walkthrough

With the app running (`docker compose up -d --build --wait` on a fresh volume, so the seed data is untouched). Needs `curl` and `jq`. The output below is real, with some fields trimmed.

```bash
BASE=http://localhost:3000
JSON='content-type: application/json'

# 1. Create a cart
CART=$(curl -s -X POST $BASE/carts | jq -r .id)

# 2. Set items (absolute quantities)
curl -s -X PUT $BASE/carts/$CART/items/sku-mug -H "$JSON" -d '{"quantity":2}' > /dev/null
curl -s -X PUT $BASE/carts/$CART/items/sku-tshirt -H "$JSON" -d '{"quantity":1}' | jq

# 3. Quote it. No body needed; add {"couponCode": "..."} to apply a coupon
QUOTE=$(curl -s -X POST $BASE/carts/$CART/checkout/quote | tee /dev/stderr | jq -r .quoteId)

# 4. Confirm the quote: places the order (201)
CONFIRM=$(curl -s -X POST $BASE/carts/$CART/checkout -H "$JSON" -d "{\"quoteId\":\"$QUOTE\"}")
echo "$CONFIRM" | jq
ORDER=$(echo "$CONFIRM" | jq -r .order.id)

# 5. Replay the same confirm, as a client would after a timeout: 200, same order
curl -si -X POST $BASE/carts/$CART/checkout -H "$JSON" -d "{\"quoteId\":\"$QUOTE\"}" | grep -iE '^(HTTP|idempotent-replayed)'

# 6. Read the order back
curl -s $BASE/orders/$ORDER | jq

# 7. Admin report
curl -s $BASE/admin/report | jq
```

Step 2, the cart after the second item (`version` counts the two edits):
```json
{
  "id": "b93eaf29-4c52-49f7-a626-9ded2168f0b5",
  "status": "OPEN",
  "version": 2,
  "orderId": null,
  "lines": [
    { "productId": "sku-mug", "name": "Ceramic Mug", "unitPricePaise": 29900, "quantity": 2, "lineTotalPaise": 59800, "sufficientStock": true },
    { "productId": "sku-tshirt", "name": "Cotton T-Shirt", "unitPricePaise": 49900, "quantity": 1, "lineTotalPaise": 49900, "sufficientStock": true }
  ],
  "subtotalPaise": 109700,
  "currency": "INR"
}
```

Step 3, the quote (stored, and tied to cart version 2; nothing is reserved):
```json
{
  "quoteId": "6f5fd09e-3734-4a70-a7e0-5595d2695b95",
  "cartId": "b93eaf29-4c52-49f7-a626-9ded2168f0b5",
  "cartVersion": 2,
  "lines": [ "… same two lines …" ],
  "subtotalPaise": 109700,
  "couponApplied": null,
  "discountPaise": 0,
  "totalPaise": 109700,
  "currency": "INR",
  "createdAt": "2026-10-29T18:25:27.234Z"
}
```

Step 4, the order: HTTP `201`.
```json
{
  "order": {
    "id": "f27fafb8-881e-4522-920a-696e3cf86bfb",
    "cartId": "b93eaf29-4c52-49f7-a626-9ded2168f0b5",
    "quoteId": "6f5fd09e-3734-4a70-a7e0-5595d2695b95",
    "placementNumber": 1,
    "lines": [ "… same two lines, without stock fields …" ],
    "subtotalPaise": 109700,
    "couponApplied": null,
    "discountPaise": 0,
    "totalPaise": 109700,
    "earnedCoupon": null,
    "currency": "INR",
    "createdAt": "2026-10-29T18:25:27.261Z"
  },
  "earnedCoupon": null
}
```

Step 5, the replay returns the same body with a different status and a header:
```
HTTP/1.1 200 OK
idempotent-replayed: true
```

Step 6 returns the same order object as `.order` in step 4. Step 7, the report:
```json
{
  "placedOrders": 1,
  "productsSold": [
    { "productId": "sku-hoodie", "name": "Fleece Hoodie", "quantity": 0 },
    { "productId": "sku-mug", "name": "Ceramic Mug", "quantity": 2 },
    { "productId": "sku-tshirt", "name": "Cotton T-Shirt", "quantity": 1 },
    "… every product is listed, unsold ones with 0 …"
  ],
  "grossRevenuePaise": 109700,
  "totalDiscountPaise": 0,
  "netRevenuePaise": 109700,
  "coupons": { "generated": 0, "available": 0, "redeemed": 0 },
  "currency": "INR",
  "generatedAt": "2026-10-29T18:25:27.338Z"
}
```

With the default `COUPON_EVERY_N_ORDERS=5`, the fifth placed order's response carries an `earnedCoupon`. Pass its `code` as `couponCode` when quoting another cart.

## Behaviour notes for clients

- **`PUT` quantity 0 on an unknown product returns `404 PRODUCT_NOT_FOUND`, while `DELETE` of the same product returns `200`.** `PUT` validates the product, `DELETE` is an idempotent no-op.
- **An unknown quote on an already checked-out cart returns `409 CART_ALREADY_CHECKED_OUT`, not `404`.** On an open cart it is `404 QUOTE_NOT_FOUND` (also for another cart's quote).
- **Every `409` from confirm leaves the cart `OPEN` and any coupon available.** Nothing changed, so re-quote and confirm again. `QUOTE_STALE` says why: `CART_CHANGED`, or `PRICE_CHANGED` with the per-product `changes`.
- **`earnedCoupon` can appear later.** With `AUTO_GENERATE_COUPONS=false` the nth order has `earnedCoupon: null` until an admin calls `POST /admin/coupons`. After that, `GET /orders/{id}` for that order shows the coupon. Order lines and totals never change.
- **A confirm retry is safe.** The same quote on the same cart replays the original order (`200` plus `Idempotent-Replayed: true`) and never places a second one. A different quote on a checked-out cart is `409`.
- `503 TRANSIENT_CONFLICT` (deadlock, serialization failure or lock timeout) is safe to retry as is.
- Validation is strict: `"5"` is rejected where an integer is expected, and unknown body fields are rejected. Unknown routes return `404 ROUTE_NOT_FOUND` in the same error envelope.

## Testing

`npm test` runs 137 tests in 12 files against a **real Postgres** (`checkout_test`). Each file resets the schema, files run one after another, and concurrency happens *inside* a test with `Promise.all` over `app.inject()`.

- **Races** ([SPECIFICATIONS §9](SPECIFICATIONS.md)):
  - T4: 10 parallel confirms of one quote make one order
  - T5: 10 carts race for the last 2 sneakers, so nothing oversells
  - T6: 5 carts race for one coupon, so one wins
  - T12: 10 parallel admin generates give one coupon per milestone
  - T13: 20 parallel confirms place orders 1..20 with no gaps and earn exactly 4 coupons
  - a deterministic test that an item edit waits for an in-flight checkout of its cart, then gets a 409 and leaves the line alone (I4)
- **Correctness paths:** stale quotes (T8, T9), a coupon surviving a failed checkout (T7), the order snapshot surviving a price change (T10), the milestone coupon (T11), report reconciliation (T14), validation and error codes, the pg type parsers and transaction helper.
- **Invariants:** every concurrency test ends with `expectInvariants()` in [test/helpers.ts](test/helpers.ts) (T15). It checks that stock plus units sold equals the seed stock, that coupons and orders agree, that each order's totals add up, and that the placement counter equals the order count.
- Constraint violations are asserted by SQLSTATE and constraint name, so a test cannot pass for the wrong reason.

Run them with `npm test` (local, needs `npm run db:up`) or `docker compose run --rm --build app npm test` (needs nothing else).

## Status

**Implemented:** products (seeded), carts with absolute-quantity edits, two-step checkout (quote, then confirm) with an optional coupon, a staleness check, idempotent replay and the milestone coupon, orders, the admin coupon, order and report endpoints, OpenAPI with per-route error codes, a containerized app with docker-compose and migrations on start, and the test suite above.

**Deferred on purpose:** authentication, customer-bound coupons and expiry, quote expiry, a generic `Idempotency-Key`, real payments and reservations, admin product management, pagination and observability. See [DECISIONS §7](DECISIONS.md) for each reason.

**Time spent:** _TODO (to be filled in)_
