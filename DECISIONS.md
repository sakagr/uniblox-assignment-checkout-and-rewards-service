# DECISIONS.md

Checkout and rewards service. TypeScript, Fastify, PostgreSQL (`pg`, no ORM), Vitest.

> Status: final for submission. Written at design time, then brought in line with what was built; where the build changed the design, the change is stated where it applies.
> Approximate time spent: about 2.5 hours on design (brief analysis, invariants, this document and SPECIFICATIONS) and about 4 hours on implementation, tests and docs, about 6.5 hours in total. That is over the 4–6 hour timebox. The overrun went into design and into proving the concurrency claims (deterministic race tests, mutation checks), not into extra features.

---

## 1. System invariants

Each invariant names the mechanism that enforces it. "Tx" means it is enforced inside the checkout (confirm) transaction.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Product stock is never negative. | `CHECK (stock >= 0)`; conditional decrement `... WHERE stock >= $qty` (Tx) |
| I2 | For every product, stock sold equals Σ `order_lines.quantity`. | Stock changes only in the checkout Tx, alongside the order-line inserts |
| I3 | A cart produces at most one order. | `UNIQUE (orders.cart_id)`; cart row lock + `OPEN → CHECKED_OUT` transition (Tx) |
| I4 | A checked-out cart is immutable. | Item endpoints lock the cart row and reject a non-`OPEN` status with 409 |
| I5 | A coupon is redeemed at most once, and only by a committed order. | Conditional `UPDATE ... WHERE redeemed_order_id IS NULL` (Tx); `UNIQUE (coupons.redeemed_order_id)`; FK to `orders` deferred to commit |
| I6 | At most one coupon exists per milestone, and only once the milestone is reached. | `UNIQUE (coupons.milestone)`; eligibility `milestone * n <= placed_orders`, read under the counter lock |
| I7 | Orders are immutable and self-describing. | Snapshot columns on `orders` / `order_lines`; no update paths in code (insert-only) |
| I8 | Totals are consistent: `line_total = unit_price × qty`, `subtotal = Σ line_total`, `0 ≤ discount ≤ subtotal`, `total = subtotal − discount`. | Single pure `calculateTotals()`; row-level `CHECK` constraints on `orders` / `order_lines` |
| I9 | Placement numbers are unique and gapless, `1..N`, in commit order. | Single counter row incremented in the checkout Tx (a rollback undoes the increment); `UNIQUE (orders.placement_number)` |
| I10 | The report is read-only and reconciles with orders and coupons. | One `REPEATABLE READ, READ ONLY` transaction; every figure is derived from orders, order lines and coupons |
| I11 | Cart lines reference existing products and have quantity 1..1000. | FK to `products`; `CHECK (quantity BETWEEN 1 AND 1000)`; setting quantity 0 deletes the line |
| I12 | An order is placed only at exactly the lines, unit prices and coupon the client was quoted. | Confirm compares `carts.version` with the quote and compares locked product prices with the quote line prices, under the locks (Tx) |

---

## 2. Ambiguities and chosen semantics

| Question | Chosen semantics |
|---|---|
| Who owns a coupon? There are no users. | A coupon is a **store-wide bearer code**. Whoever presents it may redeem it once. |
| How does a customer receive a coupon? | (a) **Automatically**: the checkout that places the nth order generates a coupon and returns it in the response, and `GET /orders/{id}` for that order also shows it. (b) **Admin**: the admin endpoint returns the code, and distribution is the admin's job (out of scope). |
| Auto-generated or admin-requested? | Both. Auto-generation is on by default (`AUTO_GENERATE_COUPONS=true`). The admin endpoint is an idempotent backfill for any reached milestone that has no coupon yet. |
| Which order is "the nth"? | It is ordered by `placement_number`, assigned from the counter at commit time. It is never ordered by `orders.id` or `created_at`, because sequence IDs are allocated before commit and can leave gaps. |
| Several milestones reached before the admin acts (auto-gen off) | Each admin call generates **one** coupon, for the lowest unrewarded milestone, and reports `pendingMilestones` so the admin can call again. |
| Do discounted orders count toward milestones? | Yes. They are successfully placed orders. |
| Coupon scope | One coupon per order. It applies to the whole subtotal and has no expiry and no minimum order value. The percent is snapshotted onto the coupon at generation time. |
| Coupon on the order that earns one | The earned coupon is created *after* that order's totals are fixed, so it cannot apply to its own order. |
| Changing `n` or `x` between runs | Out of scope. `n` and `x` are fixed per deployment. Existing coupons keep their snapshotted percent. |
| Price or stock changes after an item is added | The cart stores only product and quantity. Viewing the cart shows **current** prices plus `availableStock` and `sufficientStock` for each line. Stock is not reserved. |
| Price changes between quote and confirm | **Any** unit-price difference, increase or decrease, makes the quote stale (409 `QUOTE_STALE`, `reason: PRICE_CHANGED`). The client re-quotes. The customer always pays exactly the total they confirmed. |
| Cart edited after a quote | The quote becomes stale (`reason: CART_CHANGED`), detected through `carts.version`. The cart is **not** frozen while a quote exists. |
| Does a quote reserve stock or the coupon? | No. The quote reports availability. Confirm can still fail with `INSUFFICIENT_STOCK` or `COUPON_ALREADY_REDEEMED`. |
| Quote expiry | None. The staleness check already guarantees correctness, so expiry is deferred as hygiene. |
| Adding more than the available stock | Rejected (409) by a **soft check** against the current DB stock. It is advisory, and checkout remains the authoritative gate. |
| Quantity 0, or above 1000 | `PUT` with quantity 0 removes the line. Above 1000 is rejected with 400. `DELETE` also removes the line. Removing a line that is not in the cart is a no-op and returns 200. |
| Checkout retried after success | The same `quoteId` returns the **same order** with 200 and the header `Idempotent-Replayed: true`. A different `quoteId` on a checked-out cart returns 409 `CART_ALREADY_CHECKED_OUT`. |
| Unknown quote on a checked-out cart | 409 `CART_ALREADY_CHECKED_OUT`, not 404. Confirm locks the cart first and answers from its state. Only on an `OPEN` cart is an unknown quote (or another cart's) 404 `QUOTE_NOT_FOUND`. |
| `earnedCoupon` on an existing order | Order lines and totals never change. `earnedCoupon` can change from `null` to a coupon later, only when auto-generation is off and an admin backfills that milestone; a replay after the backfill shows it. |
| `PUT` quantity 0 vs `DELETE` on an unknown product | `PUT` sets the quantity of a product, so the product must exist: 404 `PRODUCT_NOT_FOUND`. `DELETE` removes a line idempotently: 200 no-op. |
| A price change and a stock shortfall at the same confirm | `PRICE_CHANGED` wins. A stale quote must be re-quoted anyway, and the re-quote reports the stock. Pinned by a test. |
| Checkout retried after failure (e.g. out of stock, stale quote) | The cart stays `OPEN` and any coupon stays available. The client re-quotes and confirms again. |
| Payment | No payment step. A committed checkout counts as paid (see D4). |

---

## 3. Material design decisions

### Decision 1: PostgreSQL with conditional updates as the concurrency primitive

**Context:** The evaluators send concurrent and repeated requests, so the invariants must hold under real overlap.

**Options considered:**
- In-memory store with a mutex.
- SQLite.
- PostgreSQL with explicit `SELECT ... FOR UPDATE` and an application-side check.
- PostgreSQL with conditional `UPDATE ... WHERE <guard>`, checking the affected row count.

**Choice:** PostgreSQL via docker-compose. A conditional update is the authority for every contended resource (stock, coupon). Row locks (`FOR UPDATE`) are used where a whole aggregate must be serialized (the cart), or where values must be read and compared before the write (product prices at confirm).

**Why:**
- In-memory and SQLite make concurrency correct trivially (one writer), so they demonstrate little and do not carry over to multiple instances.
- A conditional update is a single atomic statement. Under READ COMMITTED, a competing transaction blocks on the row lock, then re-evaluates the `WHERE` clause after the first one commits or rolls back.
- This avoids the read-check-write race that a separate `SELECT` invites.

**Consequences:** Correctness lives in the database, so application instances are stateless and can scale horizontally. Tests need a running Postgres.

### Decision 2: Cart ID as the checkout idempotency key, with replay keyed on the quote

**Context:** Clients retry checkout after timeouts. A retry must not create a second order or deduct stock twice.

**Options considered:**
- A client-supplied `Idempotency-Key` header, with the request hash and response stored.
- The cart itself as the natural key.
- No idempotency; return an error on the second attempt.

**Choice:**
- `UNIQUE (orders.cart_id)`, and `orders.quote_id` records which quote produced the order.
- Confirm locks the cart row first. If the cart is already `CHECKED_OUT` and the request's `quoteId` matches `orders.quote_id`, it returns the existing order with 200 and the header `Idempotent-Replayed: true`.
- Any other `quoteId` gets 409 `CART_ALREADY_CHECKED_OUT`.

**Why:**
- The domain already says a cart checks out at most once, so the key exists for free and needs no TTL or storage.
- The `quoteId` acts as the request fingerprint: a genuine retry carries the same one.
- Concurrent retries serialize on the cart lock. The second one wakes up, sees `CHECKED_OUT`, and replays.

**Consequences:**
- Retries return an identical result, including any earned coupon.
- Item endpoints are naturally idempotent (see D11). `POST /carts` and `POST /checkout/quote` are not deduplicated, but are harmless: they create an empty cart or a quote row.
- A general `Idempotency-Key` mechanism is deferred.

### Decision 3: Authoritative stock check at confirm only, with no reservation at add-to-cart or quote

**Context:** Overselling must not happen, and stock can change at any point before the order is placed.

**Options considered:**
- Reserve stock at add-to-cart or quote time, with expiry.
- Check at add time only.
- An advisory check at add and quote time plus an authoritative conditional decrement at confirm.

**Choice:** The third option.
- Confirm locks the products with `SELECT … WHERE id = ANY($ids) ORDER BY id FOR UPDATE` and checks every line's stock under those locks. Any short line rolls back the whole transaction with 409 `INSUFFICIENT_STOCK`, listing every short line with requested and available.
- It then decrements all lines in one guarded statement: `UPDATE products p … FROM unnest($ids, $qtys) v … WHERE p.id = v.id AND p.stock >= v.qty RETURNING p.id`. A line missing from `RETURNING` is also `INSUFFICIENT_STOCK`.

**Why:**
- Reservations need expiry jobs and abandoned-cart handling, which is too much for the timebox and has its own failure modes.
- Locking products in a deterministic order prevents deadlocks between overlapping carts.
- The batched `UPDATE … FROM unnest` takes its row locks in arbitrary order. It is deadlock-safe **only because** the ordered `FOR UPDATE` already holds every one of those rows. The code comment says so, so nobody removes the `SELECT … FOR UPDATE` thinking the guarded update is enough.

**Consequences:**
- A customer can be quoted for an item and still lose the last unit at confirm. The error says exactly which item and how many units are available.
- The defences are layered: the under-lock check, the guarded `UPDATE`, and `CHECK (stock >= 0)` behind both. Removing either application guard alone fails no test, by design; removing both makes T5 fail (§10).

### Decision 4: Coupon redemption in the same transaction as order creation, with no payment step

**Context:** A coupon must be redeemed once, must not be consumed by a failed checkout, and must not be won by two concurrent checkouts.

**Options considered:**
- A reservation state machine (`AVAILABLE → RESERVED → REDEEMED`, with release on failure).
- An application-level lock per coupon.
- A conditional update inside the checkout transaction.

**Choice:**
- Confirm generates the order UUID up front, then runs `UPDATE coupons SET redeemed_order_id = $orderId, redeemed_at = now() WHERE id = $couponId AND redeemed_order_id IS NULL`.
- The FK from `coupons.redeemed_order_id` to `orders` is `DEFERRABLE INITIALLY DEFERRED`, so the order row can be inserted later in the same transaction, while the lock order still takes the coupon before the products.
- `UNIQUE (redeemed_order_id)` is the backstop.
- No payment integration: a committed checkout counts as paid.

**Why:**
- A failed checkout rolls back the redemption automatically, so "not lost by a failed checkout" holds by construction.
- A concurrent loser blocks on the coupon row. When it wakes, it either matches zero rows (the winner committed) or succeeds (the winner rolled back).
- A reservation model is needed only when a slow external step, such as a payment, sits outside the transaction. Here there isn't one.
- *Alternative rejected:* lock the coupon first and write the order ID after the order insert. That needs a two-step update and an intermediate "redeeming" state, whereas the deferred FK keeps one statement as the authority.

**Consequences:** With real asynchronous payments this design must evolve: order `PENDING`, coupon reserved with expiry, confirmed or released when payment settles (see §8).

### Decision 5: A placement counter row for milestones

**Context:** "Every nth order" needs a deterministic, gapless order count that matches commit order.

**Options considered:**
- `orders.id` from a sequence.
- `ROW_NUMBER() OVER (ORDER BY created_at, id)` computed at generation time.
- A dedicated counter row incremented inside checkout.

**Choice:** A single row `store_stats(placed_orders)`. Confirm runs `UPDATE ... SET placed_orders = placed_orders + 1 RETURNING placed_orders` and stores the result as `orders.placement_number` (UNIQUE).

**Why:**
- Sequence IDs are allocated before commit and leave gaps on rollback. If order 6 commits before order 5, "the 5th order" changes depending on when you look.
- The counter increments inside the transaction, so a rollback undoes it. The counter is always gapless, and it equals the number of committed orders.

**Consequences:**
- All confirms serialize on one row. To keep the hold short, the counter is locked **last**, just before the inserts and commit.
- This is acceptable at this scale. At production scale it becomes the hotspot (see §8).

### Decision 6: Auto-generate the coupon on the nth order, with admin generation as an idempotent backfill

**Context:** The brief requires admin-requested generation. The product goal is for the customer whose order hits the milestone to receive a coupon immediately.

**Options considered:**
- Admin-only generation.
- Automatic generation only.
- Both, made safe for each other.

**Choice:** Both.
- When `placement_number % n == 0` and `AUTO_GENERATE_COUPONS` is on, confirm inserts the milestone coupon in the same transaction with `INSERT ... ON CONFLICT (milestone) DO NOTHING`, links it to the order, and returns it in the response.
- `POST /admin/coupons` locks the counter row (`FOR UPDATE`), finds the lowest milestone `k` with `k*n <= placed_orders` and no coupon, and inserts it. If none exists, it returns 409 `NO_ELIGIBLE_MILESTONE`.

**Why:**
- `UNIQUE (milestone)` guarantees one coupon per milestone, whichever path creates it.
- `ON CONFLICT DO NOTHING` means coupon generation can never fail an order. Under this design it cannot actually fire, because admin cannot create the milestone first (next bullet). It would only fire if `n` changed between runs.
- Admin cannot pre-empt a milestone whose order is still in flight because of **visibility**, not the lock: it counts only committed placements, so it sees `k*n − 1` until that confirm commits, and by then the confirm has created the coupon itself.
- The counter lock (`FOR UPDATE` on `store_stats`) does two other things. It serializes admin calls, so a loser waits and gets a clean 409 instead of a `UNIQUE (milestone)` violation. And it makes admin wait for an in-flight confirm, so it answers from the up-to-date count. Measured without the lock: losers returned 500 with 23505 on `coupons_milestone_key` (§10).
- The flag lets the admin path be exercised on its own, which matches the brief's wording.

**Consequences:**
- With auto-generation on, the admin endpoint is normally a no-op (409). Its value is backfill: when auto-generation was off, or after a recovery.
- With auto-generation off, the milestone order is placed with `earnedCoupon: null`; it never waits for an admin, since that would hold the counter lock and block every checkout. After a backfill, `GET /orders/{id}` shows the coupon.
- `rewardedMilestones` and `pendingMilestones` count only coupons with `milestone <= reached`, so they stay non-negative if `n` changes between runs.

### Decision 7: Two-step checkout (quote, then confirm) with a strict staleness check

**Context:**
- Prices and cart contents can change between the customer seeing a total and placing the order.
- Order history must explain what was bought, even after product data changes.
- The customer should get a chance to reconsider rather than being silently charged a different amount.

**Options considered:**
- Lock prices at add-to-cart.
- A single-step checkout that reprices silently at current prices.
- A single-step checkout with a client-sent `expectedTotalPaise` guard.
- Quote then confirm, with the quote stored server-side.
- Quote then confirm, with a stateless signed quote token (HMAC).

**Choice:**
- `POST /carts/{id}/checkout/quote` validates the cart and coupon, prices every line at current prices, and stores a quote: cart version, coupon, line snapshots and totals.
- `POST /carts/{id}/checkout` with `{quoteId}` places the order exactly as quoted. Under the locks it checks two things:
  - `carts.version == quote.cart_version`. Otherwise it returns `QUOTE_STALE` with reason `CART_CHANGED`.
  - Every locked unit price equals the quoted price. Otherwise it returns `QUOTE_STALE` with reason `PRICE_CHANGED`, plus the per-line differences.
- **Any** price difference is stale, including decreases. The order's line snapshots copy the quoted (equal to the current) values.

**Why:**
- A silent reprice charges the customer something they never saw. A total-only guard can't explain *what* changed.
- A stored quote is debuggable, and a diff gives a useful error. It also means the coupon travels with the quote, which is the contract, rather than being re-sent.
- A signed token avoids a table, but needs secret management and can't produce a per-line diff without re-embedding every line.
- Comparing prices *under* the `FOR UPDATE` locks closes the time-of-check-to-time-of-use gap.
- Strict equality is deterministic and easy to explain.
- No quote expiry and no cart freezing: the version and price checks give the same safety without extra state or unlock paths.

**Consequences:**
- Clients make two calls to place an order. A stale quote costs one extra round trip.
- Quote rows accumulate. Cleanup or expiry is deferred.
- A quote never reserves stock or the coupon (D3, D4).
- Confirm reports problems in a fixed order, each step tested: cart missing (404) → checked out (replay or 409) → quote missing (404) → `CART_CHANGED` → coupon already redeemed → `PRICE_CHANGED` → `INSUFFICIENT_STOCK`.

### Decision 8: Fastify with raw `pg`, no ORM

**Context:** The interview will probe exactly where invariants are enforced, and the API must be documented.

**Options considered:**
- Express 5.
- NestJS.
- Fastify.
- An ORM (Prisma or TypeORM) versus raw `pg`.

**Choice:** Fastify with TypeBox route schemas, `@fastify/swagger` for OpenAPI, and raw `pg` behind a small `withTransaction(fn)` helper.

**Why:**
- Schema validation gives consistent 400 responses, and the same schemas generate the API documentation.
- `app.inject()` lets tests fire many concurrent requests in-process.
- NestJS adds scaffolding and abstraction that a 4–6 hour timebox cannot afford.
- ORMs hide lock behaviour and affected-row counts, which are exactly what correctness depends on here.

**Consequences:** SQL is written by hand and reviewed line by line, and there is no migration framework (plain SQL migration files).

### Decision 9: A fixed lock-acquisition order in checkout

**Context:** Checkouts that share a coupon and overlapping products could deadlock.

**Options considered:**
- Ad hoc ordering with retry on deadlock.
- SERIALIZABLE isolation with retry.
- A fixed global lock order.

**Choice:** **cart (`FOR UPDATE`) → coupon (conditional update) → products (`FOR UPDATE`, sorted by id, then conditional decrement) → counter (increment)**. Admin generation takes **counter → coupon insert**. Both paths lock the counter before inserting a milestone coupon, and admin never locks an existing coupon row.

**Why:** A consistent order rules out lock cycles without retry machinery. READ COMMITTED plus conditional updates gives the needed guarantees without the serialization-failure retries that SERIALIZABLE would require.

**Consequences:** Any new code path that touches these rows must follow the order (documented next to `withTransaction`). Unexpected `40P01` (deadlock) or `40001` (serialization failure) errors map to 503 `TRANSIENT_CONFLICT`, which is safe to retry because confirm is idempotent.

### Decision 10: Unguessable bearer coupon codes

**Context:** Without user binding, possession of the code is the only access control.

**Options considered:**
- Sequential codes (`SAVE-5`).
- UUIDs.
- Short random codes.

**Choice:** 12 characters of Crockford base32, generated from `crypto.randomBytes` (about 60 bits of entropy), stored uppercase. Input is trimmed and uppercased.

**Why:** Sequential codes are trivially enumerable. UUIDs are unfriendly to type. 60 bits makes guessing infeasible at any realistic request rate.

**Consequences:** Brute-force rate limiting and binding coupons to customers are deferred (see §7).

### Decision 11: Absolute-quantity item updates, and an API shaped for evaluation

**Context:** Cart edits may be retried. Evaluators need to drive the API by hand and reconcile the report.

**Options considered:**
- `POST /items` to add plus increments.
- `PUT` with an absolute quantity.
- UUID versus readable product IDs.
- Report-only admin views versus listing endpoints.

**Choice:**
- `PUT /carts/{id}/items/{productId}` with `{quantity: 0..1000}` sets an absolute quantity, and 0 removes the line. `DELETE` also removes it. Both return 200 with the full cart view.
- Products use readable IDs (`sku-mug`). Carts, quotes and orders use UUIDs.
- `GET /admin/orders` and `GET /admin/coupons` exist alongside `GET /admin/report`.

**Why:**
- An absolute set is idempotent under retry, whereas "add 1" applied twice silently doubles.
- The 1000 cap bounds `price × qty` and rejects absurd input at the schema.
- Readable product IDs make manual testing and seed data obvious.
- Listing endpoints let a reviewer check the report against the orders and coupons the system returns, as the brief requires.

**Consequences:** There is no endpoint for "add one more". The client sends the new total quantity.

### Decision 12: Run the app in a container, executing TypeScript with tsx

**Context:** Evaluators run the service on their own machines, and the brief asks for repeatable setup with no dependency on private services. Node versions, lockfile drift and host paths are the usual sources of "works on my machine".

**Options considered:**
- Host Node only, with compose providing just Postgres.
- A container running compiled `dist/` with production dependencies only.
- A container running the TypeScript sources with tsx, with the full dependency set.

**Choice:** The third.
- `node:22-alpine`, `npm ci` from the lockfile, running as the `node` user. devDependencies stay in the image.
- `CMD` runs the migrations, then `exec`s the server through tsx.
- A compose `app` service with `init: true`, `depends_on: db` (healthy), and the database URLs set explicitly to the `db` host.
- `docker compose up -d --build --wait` is the whole setup; `docker compose run --rm --build app npm test` runs the suite.

**Why:**
- Compiled output breaks the migration runner: `tsc` emits `migrate.js` under `dist/src/db`, where `../../migrations/` resolves to `dist/migrations`. tsx keeps the image layout identical to the repo.
- Keeping devDependencies lets an evaluator run the full test suite with only Docker installed. Image size doesn't matter here.
- Migrations on every start are safe: each run holds an advisory lock, and `schema_migrations` makes re-runs no-ops.
- `exec` plus tini (`init: true`), not `npm start`: npm doesn't forward SIGTERM, so graceful shutdown would never run. Measured: `docker compose stop app` takes about 0.3 s and exits 0, with the shutdown logged.
- The database URLs are explicit, never `env_file: .env`: the host `.env` points at `localhost`, which inside the container is the container itself.
- The healthcheck uses `node -e "fetch(…)"`, so it doesn't depend on `wget` or `curl` in the base image.

**Consequences:**
- Verified on a fresh volume (healthy, seeded). The suite passed inside the container both as linux/arm64 and as linux/amd64, so the lockfile carries the Linux native packages (Rolldown, esbuild) an evaluator's machine needs.
- Local development still works with host Node ≥ 20.12 against the compose Postgres. The README covers the port clash when both run.
- A production image would be multi-stage with production dependencies only, and migrations would run as a one-off job rather than on every replica start (§8).

---

## 4. Transaction, concurrency and idempotency strategy

**Isolation:**
- READ COMMITTED (the Postgres default) for item edits, confirm and admin generation.
- REPEATABLE READ for quotes, so the cart version and its items come from one snapshot (below).
- REPEATABLE READ READ ONLY for the report, so its **separate** queries agree: `productsSold` covers exactly the orders counted in `placedOrders` and gross revenue, and the coupon counts match the discounted orders. (`net = gross − discount` and `generated = available + redeemed` each come from a single statement and hold at any isolation level.)
- These two isolation choices are argued, not test-proven. A deterministic test would have to open the window between two statements inside one request, which needs hooks in the handler. That is stated again in §7.

**Quote (`POST /carts/{id}/checkout/quote`, short `REPEATABLE READ` transaction, no locks on contended rows):**

The quote reads the cart version and its items from a single snapshot. Under READ COMMITTED, an edit committing between the two reads could pair version *v+1* with the items of *v*, and that quote would then wrongly pass the confirm version check.

1. Read the cart, including its `version`.
   - Missing cart: 404 `CART_NOT_FOUND`.
   - `CHECKED_OUT`: 409 `CART_ALREADY_CHECKED_OUT`.
   - No lines: 422 `EMPTY_CART`.
2. If a coupon code is given, read it.
   - Missing: 422 `COUPON_INVALID`.
   - Redeemed: 409 `COUPON_ALREADY_REDEEMED`.
3. Read the current prices and stock.
   - Any line short: 409 `INSUFFICIENT_STOCK` (advisory).
4. Run `calculateTotals`, insert the quote (cart version, coupon, line snapshots, totals), and return it.

The cart version is captured with the items it describes, so any later edit is caught at confirm.

Verified on PostgreSQL 16: a quote racing a committing cart edit still commits, carrying the version from its snapshot. The `checkout_quotes → carts` FK check needs only a key-share lock, which doesn't conflict with the version update, so there is no serialization error. Confirm then rejects that quote as `CART_CHANGED`.

**Item edits (`PUT` / `DELETE`):** lock the cart (`FOR UPDATE`), check it is `OPEN`, change the line, and bump `carts.version` only if a row actually changed. A retried PUT with the same quantity therefore does not invalidate an outstanding quote.

**Confirm (`POST /carts/{id}/checkout`, single transaction):**

1. **Lock the cart.** `SELECT … FROM carts WHERE id = $1 FOR UPDATE`.
   - Missing cart: 404 `CART_NOT_FOUND`.
   - `CHECKED_OUT` with `orders.quote_id = quoteId`: replay with 200.
   - `CHECKED_OUT` with any other quote, including an unknown one: 409 `CART_ALREADY_CHECKED_OUT`.
   - The cart is locked before the quote is read. Reading the quote first (the original design) made `CART_NOT_FOUND` unreachable, because no quote can exist for an unknown cart.
2. **Load the quote for this cart.** Quote rows are only read, never locked, so the lock order is unchanged.
   - Missing, or another cart's: 404 `QUOTE_NOT_FOUND`.
   - Version differs from the quote: 409 `QUOTE_STALE` (`CART_CHANGED`).
   - Defensive: the cart's items must equal the quote lines. A mismatch at the same version can only mean an edit skipped the version bump, so it is a 500, not a 409.
3. **Redeem the coupon** (if the quote has one). Generate `orderId` (UUID) in the app, then run the conditional redeem. Zero rows: 409 `COUPON_ALREADY_REDEEMED`.
4. **Lock the products** in id order (`FOR UPDATE`), then check under the locks:
   - any price differs from the quote: 409 `QUOTE_STALE` (`PRICE_CHANGED`, per-line `{productId, quotedPaise, currentPaise}`);
   - then any short line: 409 `INSUFFICIENT_STOCK`, listing every short line.
5. **Decrement stock** in one guarded statement (D3).
6. **Recompute totals** with `calculateTotals`. They must equal the quote's; a mismatch is a 500 (defensive).
7. **Increment the counter.** The result becomes `placement_number`. It is locked last and held until commit.
8. **Write the order.** Insert the order (`id = orderId`, `quote_id`) and its line snapshots from the quote, then set the cart to `CHECKED_OUT`.
9. **Generate the milestone coupon.** If `AUTO_GENERATE_COUPONS` is on and `placement_number % n == 0`: `INSERT … ON CONFLICT (milestone) DO NOTHING` (defensive; see D6).
10. **Commit.** The deferred FK is checked here. The response comes from the same loader as every replay, so they are identical by construction.

Any failure in steps 2–9 rolls back everything: stock, coupon redemption, counter and order.

**What happens under each race:**

| Scenario | Outcome | Test |
|---|---|---|
| The same quote confirmed N times in parallel | The first holds the cart lock and commits. The others block, then see `CHECKED_OUT` with a matching `quote_id` and replay: 1 order, stock deducted once. | T4 |
| N carts competing for the last K units | The product row locks serialize the decrements. Exactly K succeed, and the rest roll back with 409. Final stock is 0. | T5 |
| Two carts with the same coupon | The second blocks on the coupon row. If the first commits, the second gets 409 `COUPON_ALREADY_REDEEMED` and its cart stays `OPEN`. If the first rolls back, the second redeems. | T6 |
| A confirm fails after redeeming a coupon (stock or stale price) | The whole transaction rolls back, and the coupon is available again. | T7, T8 |
| Price updated between quote and confirm | Confirm reads the new price under the lock and returns 409 `QUOTE_STALE`. No stock change, coupon untouched. | T8 |
| Price update racing with an in-flight confirm | The update blocks on the product row lock until the confirm commits. The order holds the quoted price, and later quotes see the new price. | argued |
| Cart edited after the quote | Its version increments, and confirm returns `QUOTE_STALE` (`CART_CHANGED`). | T9 |
| Quote racing a cart edit | The quote commits with its snapshot's version; confirm returns `CART_CHANGED`. | verified manually (above) |
| Cart edited during confirm | The edit blocks on the cart lock. Afterwards it sees `CHECKED_OUT` and gets 409, and the line is unchanged. | I4 cart-lock test (deterministic) |
| Many confirms reaching milestones together | Placements are exactly 1..N with no gaps, and each milestone order gets exactly one AUTO coupon. | T13 (20-way) |
| Concurrent admin generate calls | The counter lock serializes them: a loser wakes, sees the winner's coupon, and gets a clean 409. `UNIQUE (milestone)` is the backstop; without the lock, losers hit it and return 500 (§10). | T12 |
| Admin generate during an in-flight milestone confirm | Admin waits on the counter lock. Then the coupon already exists (auto-generation on: 409), or admin creates it for the now-committed order (auto-generation off), or the confirm rolled back and the milestone isn't reached (409). Without the lock, admin still couldn't pre-empt: it only sees committed placements. | argued |

---

## 5. Money and rounding

- **Representation:** every amount is an integer count of **paise** (₹1,299.00 is stored as `129900`). There is never a split rupees/paise pair and never a float.
- **Storage:**
  - Columns are `bigint NOT NULL CHECK (>= 0)`, named `*_paise`.
  - `pg` returns `int8` (and `SUM()` results) as strings. A single type parser converts them to `number` and asserts `Number.isSafeInteger`, failing loudly otherwise.
- **Types:**
  - TypeScript uses a branded `Paise` type, constructed only through a validating `paise()` function, so quantities or rupees cannot be mixed into money arithmetic by accident.
  - `Number.MAX_SAFE_INTEGER` (about 9×10¹⁵ paise) is far beyond any order or report total, and the 1000-per-line quantity cap bounds line totals.
- **Rounding:**
  - Percent is an integer `1..100`, snapshotted on the coupon.
  - Discount is `Math.floor(subtotal × percent / 100)`. Fractional paise always go to the store, and the rule is deterministic.
  - Floor plus `percent ≤ 100` guarantees `0 ≤ discount ≤ subtotal`, so the total is never negative.
- **Line totals:** `unit_price × quantity`, an integer product with a safe-integer assertion.
- **API:** amounts are integers with `currency: "INR"`. An optional display string (`"₹1,299.00"`) is formatted with `Intl.NumberFormat` from the integer. Clients never compute from the display string.
- **No money library.** Single-currency integer arithmetic with one percentage rule does not need one.

---

## 6. Error model

**Envelope:** `{ "error": { "code": "STABLE_CODE", "message": "human text", "details": { ... } } }`. Clients branch on `code`, never on `message`.

| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Schema failure: non-integer quantity or one outside 0..1000, unknown body field, bad UUID (details: field errors). Fastify's own client errors (malformed JSON, 413, 415) use the same code with Fastify's status. |
| 404 | `CART_NOT_FOUND`, `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `QUOTE_NOT_FOUND` | A referenced resource does not exist. A quote that belongs to another cart counts as not found. Exception: on a checked-out cart, any quote other than the one that produced the order (unknown or another cart's) is 409 `CART_ALREADY_CHECKED_OUT`. |
| 404 | `ROUTE_NOT_FOUND` | Unknown method or path |
| 409 | `CART_ALREADY_CHECKED_OUT` | Mutating or quoting a checked-out cart, or confirming it with a different quote |
| 409 | `INSUFFICIENT_STOCK` | Item soft check, quote, or confirm (details: `[{productId, requested, available}]`) |
| 409 | `COUPON_ALREADY_REDEEMED` | The coupon has already been used (quote or confirm) |
| 409 | `QUOTE_STALE` | Confirm found the cart changed or a price changed (details: `reason` of `CART_CHANGED` or `PRICE_CHANGED`; per-line `{productId, quotedPaise, currentPaise}` for price changes) |
| 409 | `NO_ELIGIBLE_MILESTONE` | Admin generate with no reached, unrewarded milestone (details: `placedOrders`, `rewardedMilestones`, `nextMilestoneAtOrder`) |
| 422 | `EMPTY_CART` | Quoting a cart with no lines |
| 422 | `COUPON_INVALID` | The coupon code does not exist |
| 503 | `TRANSIENT_CONFLICT` | Deadlock (`40P01`), serialization failure (`40001`), lock timeout (`55P03`), or a coupon-code collision (`23505` on `coupons_code_key`). Safe to retry. |
| 500 | `INTERNAL_ERROR` | Anything else, including confirm's defensive mismatches (cart items or recomputed totals differ from the quote at the same version), which can only mean a bug. No stack trace in the response; logged with the request id, which is returned in `details`. |

**Rationale:**
- 400 vs 422 separates "cannot parse" from "parsed, but the business rules reject it".
- 409 means "conflicts with the current state". The request might succeed later or after a change, and the client should re-read the state or re-quote.
- Successful replays use 200 rather than 201, with the header `Idempotent-Replayed: true`, so clients and tests can tell a replay from a new order without a different body shape.
- Domain errors are typed classes, mapped to responses in one Fastify `setErrorHandler`.
- OpenAPI lists every route's error statuses and codes, generated from the same `ErrorCode` type, so a typo is a compile error. `details` is typed `unknown` there, because the response serializer would otherwise drop its contents; temporarily typing it `null` broke 10 tests, which is how that was confirmed.

---

## 7. Implemented vs intentionally deferred

**Implemented:**
- Products (seeded, read-only listing).
- Carts with absolute-quantity set and remove.
- Two-step checkout (quote, then confirm) with an optional coupon, a staleness check, idempotent replay and the milestone coupon.
- Orders, as immutable snapshots.
- Admin coupon generation (backfill), coupon and order listings, and the report.
- OpenAPI at `/docs` with request, response and per-route error schemas.
- The app and Postgres in docker-compose: migrations and seed on start, tests runnable in the container (D12). The README walkthrough was run against the container.
- 137 tests in 12 files against a real Postgres: races T4, T5, T6, T12 and T13; a deterministic test for the item-edit cart lock; reconciliation of the report (T14); and the invariant checker (T15) after every concurrency test. Each application guard was mutation-checked (§10).

**Not proven by a test (stated plainly):**
- The quote's and the report's REPEATABLE READ (argued in §4).
- T13 itself was not mutation-checked.
- Nothing beyond 20-way concurrency; no load test.

**Deferred:**

| Item | Why deferred |
|---|---|
| Authentication and authorization | Not required by the brief. Admin routes are grouped under `/admin/*` and documented as admin-only. |
| Customer-bound coupons, coupon expiry, rate limiting on coupon attempts | No identity model. Bearer codes are high-entropy (D10). |
| Quote expiry and cleanup of old quotes | Correctness comes from the staleness check (D7). Expiry would be hygiene. |
| Generic `Idempotency-Key` for all mutating endpoints | Cart- and quote-based idempotency covers the critical path (D2). |
| Real or asynchronous payment, and stock or coupon reservations | Not required. It would force a reservation state machine (D4). |
| Admin product and price management endpoints | Tests mutate prices directly in the DB to exercise drift and stale quotes. |
| Cart expiry, pagination, observability (metrics, tracing), structured audit log | Not core to the invariants under evaluation. |
| Frontend | Optional, and it would not offset the backend. |

---

## 8. Evolution to multiple instances and production scale

- **Multiple app instances:**
  - Already supported. The instances are stateless, quotes live in the database, and every invariant is enforced in Postgres, through row locks, conditional updates and unique constraints, not in process memory.
  - Add PgBouncer (transaction pooling) and size pools per instance.
- **Counter hotspot (D5):** every confirm serializes on one row. Options, in rough order:
  1. Keep the counter but shorten the transaction.
  2. Move milestone detection off the hot path: append to an order log, and have a single consumer assign placement numbers and generate coupons asynchronously, notifying the customer by email.
  3. Shard counters if strict commit-order "nth" semantics can be relaxed.
- **Payments:**
  - Orders become `PENDING → PAID | FAILED`.
  - Stock and coupon move to *reserved* with expiry, confirmed on payment success and released on failure or timeout.
  - The quote naturally becomes the payment intent.
  - The payment call needs a provider idempotency key, and an outbox table carries events reliably.
- **Quotes:** add a TTL and a cleanup job. Optionally soft-reserve stock at quote time for high-demand items.
- **Idempotency:** a general `Idempotency-Key` table with a request hash, stored response and TTL for every mutating endpoint.
- **Reporting:**
  - Move off the primary. Either use incrementally maintained aggregate tables, updated in the confirm transaction or from an event stream, or a replica.
  - Note that replica lag weakens the "reconciles with what the API just returned" property, so define a freshness contract.
- **Coupons:** bind them to customer accounts, add expiry and per-customer limits, and rate-limit redemption attempts by IP and account.
- **Containers:** the image is already stateless. For several replicas, run migrations as a one-off job before rollout (the advisory lock already makes concurrent runs safe), and build a multi-stage image without devDependencies.
- **Operations:**
  - Migrations through a tool such as `node-pg-migrate`.
  - Structured logs with request IDs, and metrics on 409 and 503 rates and lock wait times.
  - `lock_timeout` and `statement_timeout` set per transaction.

---

## 9. How AI tools were used

I used two AI tools in a deliberate loop: Claude (chat) as design partner and reviewer, and Claude Code to implement.
- Every task followed the same cycle. Claude Code wrote a plan against SPECIFICATIONS, DECISIONS and ROADMAP. The plan was reviewed, by me and sometimes Claude as a second reviewer, when in doubt about decisions, and sent back until it was right. Only then was it implemented, and the diff, the tests and the sanity checks were reviewed again before the next task.
- `AGENTS.md` holds the standing rules: no spec or decision edits without approval, and every correction reported.
- Where the tools disagreed, or proposed something I didn't want, I made the call.

**Design decisions I redirected:**
1. **Coupon generation.** The AI proposed admin-only generation, reading the brief literally. I wanted the nth order to receive its coupon automatically in the checkout response, with admin generation kept as a backfill. That reworked the concurrency design: `ON CONFLICT DO NOTHING` in confirm, the admin path's counter lock, and the `AUTO_GENERATE_COUPONS` flag (D6).
2. **Two-step checkout.** The AI's design repriced silently at checkout, with an `expectedTotalPaise` guard deferred. I introduced quote-then-confirm so the customer can reconsider when a price changes. That led to the stored quote, `carts.version`, and the strict under-lock staleness check (D7, I12).
3. **Coupon distribution.** The AI recommended one distribution mechanism. I combined admin hand-out with linking the coupon to the milestone order, and scoped out delivery.
4. **Quantity 0.** I chose "removes the line" over "rejected".

**Worked example: a test that proved nothing.** To prove the item-edit cart lock (I4), the AI proposed parallel PUTs for different products on one cart, expecting the version to equal the number of PUTs. On review, that test passes even with `FOR UPDATE` removed: the version increment is atomic on its own, and different products never conflict.
- It was replaced with a deterministic test. A second connection locks the cart and flips it to `CHECKED_OUT`; a PUT is started and confirmed blocked through `pg_stat_activity`; the blocker commits; the PUT must return 409 with the line unchanged.
- Mutation check: with `FOR UPDATE` removed from `lockOpenCart`, the new test fails (the PUT returns 200), while the parallel-PUT test still passes. That pair is the evidence.


---

## 10. Evidence, and what I would examine with two more hours

**Mutation checks.** Each guard was removed locally, the tests run, and the change reverted. None of these is committed.

| Guard removed | Caught by | Result |
|---|---|---|
| `AND redeemed_order_id IS NULL` on the coupon redeem | T6 | two orders carried the coupon |
| Both stock defences in confirm (the under-lock check and `AND p.stock >= v.qty`) | T5 | oversell; `CHECK (stock >= 0)` turned it into a 500 instead of a 409 |
| Only `AND p.stock >= v.qty` | nothing, by design | all 137 tests pass: the under-lock check throws first (defence in depth) |
| `PRICE_CHANGED` / `INSUFFICIENT_STOCK` check order swapped | the precedence test | wrong error code |
| The cart `FOR UPDATE` in confirm | T4 | no replays |
| `FOR UPDATE` in `lockOpenCart` (item edits) | the I4 cart-lock test | the PUT returned 200 instead of 409; the parallel-PUT test still passed |
| `FOR UPDATE` on `store_stats` in admin generation | T12 | 3 runs: 2 × 201 each, the rest 500. Every 500 was `23505` on `coupons_milestone_key` (none on `coupons_milestone_order_id_key`) |

**With two more hours, I would first:**
1. **Run a mixed, high fan-out stress test:** 100+ concurrent carts, quotes, confirms, price edits and admin calls, ending in the invariant checker. Today's races are targeted and at most 20-way.
2. **Exercise a real lock timeout:** set `lock_timeout` per transaction and drive a confirm into it, testing the 503 path end to end. Today it is only tested by forcing the SQLSTATE.
3. **Close the remaining proof gaps:** mutation-check T13 (replace the counter with `count(*) + 1` and expect duplicate placements), and add a test-only hook between statements so the quote's and report's REPEATABLE READ can be tested deterministically.
4. **Add quote expiry and a generic `Idempotency-Key`** for the remaining POST endpoints (D2).
