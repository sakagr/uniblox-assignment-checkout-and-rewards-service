# ROADMAP.md

Tasks for the checkout and rewards service, in the order they are done. Work on one task at a time.

- A task is **complete** when every item in its "Done when" list is ticked.
- Tick items in the same commit as the work.
- Spec references point to `SPECIFICATIONS.md` (§) and `DECISIONS.md` (I = invariant, D = decision, T = test in SPECIFICATIONS §9).

**Timebox:** the brief asks for 4–6 hours of implementation. The estimates below add up to about 6h. If time runs short:
- trim task 10 polish first;
- then the extra checks in task 9;
- never the race tests in tasks 6 and 7.

| # | Task | Estimate | Status |
|---|---|---|---|
| 1 | Design the system | n/a | ✅ Done |
| 2 | Set up the TypeScript project | n/a | ✅ Done |
| 3 | Set up the database | n/a | ✅ Done |
| 4 | Build the app foundation | 45 min | ✅ Done |
| 5 | Products and carts | 40 min | ✅ Done |
| 6 | Checkout quote | 30 min | ✅ Done |
| 7 | Place orders (confirm checkout) | 75 min | ⬜ |
| 8 | Admin coupons and order list | 30 min | ⬜ |
| 9 | Admin report | 20 min | ⬜ |
| 10 | Harden with concurrency tests | 50 min | ⬜ |
| 11 | Write the README and API docs | 30 min | ⬜ |
| 12 | Finish DECISIONS.md | 30 min | ⬜ |
| 13 | Final check and submit | 15 min | ⬜ |

---

## 1. Design the system ✅

Analyse the brief, settle the ambiguities, and write down the design before any code.

**Done when**
- [x] Invariants, semantics and decisions recorded in `DECISIONS.md`
- [x] API, DDL, critical SQL and test plan recorded in `SPECIFICATIONS.md`
- [x] Both committed

## 2. Set up the TypeScript project ✅

Create the Node/TypeScript project with all dependencies and tooling.

**Done when**
- [x] `package.json` (ESM, Node ≥ 20.6), dependencies installed (Fastify, TypeBox provider, swagger, pg, Vitest, tsx)
- [x] `tsconfig.json` (strict, NodeNext), `vitest.config.ts` (`fileParallelism: false`)
- [x] `.gitignore`, `.env.example` covering every variable in §1
- [x] `npm run typecheck` passes
- [x] Committed

## 3. Set up the database ✅

Run Postgres locally and create the schema and seed data through migrations.

**Done when**
- [x] `docker-compose.yml` (postgres:16-alpine, TCP healthcheck), init script creating `checkout_test`
- [x] `migrations/001_schema.sql` matching §3; multi-column CHECKs explicitly named
- [x] `migrations/002_seed.sql` with 6 products, including `sku-limited-sneaker` (stock 2)
- [x] `src/db/migrate.ts`: one transaction per file, advisory lock, `--reset`, `--test`
- [x] Re-running migrations is a no-op; reset works on both databases
- [x] Constraint probe: every bad write rejected by the intended constraint; deferred FK commits when valid and fails at COMMIT when dangling
- [x] Committed

## 4. Build the app foundation ✅

Add the shared building blocks every endpoint will use: config, database pool, transactions, money maths, coupon codes, errors, and the Fastify app with `/health`.

**Done when**
- [x] `src/config.ts`: every §1 variable parsed and validated; bad values fail fast with the variable named
- [x] `src/db/pool.ts`: int8 and numeric parsed through one safe-integer parser (per-pool `types`, not global)
- [x] `src/db/tx.ts`: `withTransaction` with isolation and read-only options; a failed ROLLBACK destroys the client; lock-order comment (D9)
- [x] `src/domain/money.ts`: `Paise`, `paise()`, `calculateTotals()` (floor discount), `formatInr()`
- [x] `src/domain/coupon-code.ts`: Crockford base32 generator and `normalizeCouponCode()`
- [x] `src/domain/errors.ts`: a `DomainError` factory for every §5.4 code
- [x] `src/http/error-handler.ts`: envelope for domain errors, validation errors (400), transient pg errors (503) and unknown errors (500); `ROUTE_NOT_FOUND` for unknown routes, flagged for the spec
- [x] `src/app.ts`: `buildApp({ config, pool })` with swagger at `/docs`, `GET /health`, Ajv `coerceTypes: false` and `removeAdditional: false`
- [x] `src/server.ts`: listens on PORT; graceful shutdown on SIGINT and SIGTERM; `npm run dev` and `npm start` work
- [x] `test/helpers.ts`: `setupTestDb`, `createTestApp(overrides)`, `parallel(n, fn)`, teardown
- [x] Tests pass:
  - T1 money table
  - coupon-code format and uniqueness
  - `/health`
  - unknown-route envelope
  - bigint parser bounds
  - `withTransaction` rollback
  - `"5"` rejected for an integer body field
- [x] Committed in increments

## 5. Products and carts ✅

Let a client list products, create a cart, and set or remove item quantities.

**Done when**
- [x] `GET /products`
- [x] `POST /carts` (201 + `Location`), `GET /carts/:cartId` with current prices, line totals, `availableStock` and `sufficientStock`
- [x] `PUT /carts/:cartId/items/:productId` with absolute quantity 0..1000 (0 removes); soft stock check returns 409
- [x] `DELETE /carts/:cartId/items/:productId` (absent line is a 200 no-op)
- [x] Item edits lock the cart `FOR UPDATE`, reject a checked-out cart with 409, and bump `version` only when a row actually changed (§6.1)
- [x] Tests pass:
  - T2: invalid input gives the right 400/404/409 code, and the cart is unchanged
  - T3: qty 0 removes; repeating the same PUT doesn't bump `version`
  - Parallel PUTs for all 6 products on one cart give 6 lines and `version` exactly 6
- [x] Committed

## 6. Checkout quote ✅

Price a cart (with an optional coupon) and store the quote without changing stock, coupons or the cart.

**Done when**
- [x] `POST /carts/:cartId/checkout/quote` runs in REPEATABLE READ (§6.2)
- [x] Rejects a missing cart (404), a checked-out cart (409), an empty cart (422), an unknown coupon (422), a redeemed coupon (409), and short stock (409 with every short line)
- [x] Coupon code trimmed and uppercased; totals from `calculateTotals()`
- [x] `checkout_quotes` and `quote_lines` rows stored; response matches the §5.2 Quote shape
- [x] Test: a quote mutates nothing (stock, coupon, cart status and version unchanged)
- [x] Committed

## 7. Place orders (confirm checkout)

Turn a quote into an order exactly as quoted. This is the core of the assignment: idempotent retries, no overselling, single coupon redemption, gapless placement numbers, and the milestone coupon.

**Done when**
- [ ] `POST /carts/:cartId/checkout` follows §6.3 step by step, in the D9 lock order
- [ ] Replay: same quote on a checked-out cart gives 200 with `Idempotent-Replayed: true` and an identical body; a different quote gives 409
- [ ] Stale quote: version mismatch gives `QUOTE_STALE` / `CART_CHANGED`; price mismatch (checked after the product locks) gives `PRICE_CHANGED` with a per-line diff
- [ ] Coupon redeemed by conditional update; stock decremented by conditional update; counter incremented last
- [ ] Order and line snapshots inserted; cart set to `CHECKED_OUT`; milestone coupon auto-generated with `ON CONFLICT (milestone) DO NOTHING` when enabled
- [ ] `GET /orders/:orderId` returns the §5.2 Order shape, including `couponApplied` and `earnedCoupon`
- [x] After confirm, `GET /carts/{id}` returns `CHECKED_OUT` and `orderId` equal to the created order
- [ ] Tests pass:
  - T4: 10 parallel confirms of one quote give one order
  - T5: oversell race on the stock-2 product
  - T6: coupon race
  - T7: coupon survives a failed checkout
  - T8 and T9: stale quotes
  - T10: order history survives a price change
  - T11: auto coupon on the nth order
- [ ] Committed in increments (happy path first, then each failure mode with its test)

## 8. Admin coupons and order list

Give the administrator manual coupon generation (a backfill for missed milestones) and listing endpoints for reconciliation.

**Done when**
- [ ] `POST /admin/coupons` follows §6.4: locks the counter, picks the lowest unrewarded milestone, links it to the milestone order, returns `pendingMilestones`; 409 `NO_ELIGIBLE_MILESTONE` with details otherwise
- [ ] `GET /admin/coupons?status=` and `GET /admin/orders`
- [ ] Tests pass:
  - T12: 10 parallel generate calls with auto-generation off give exactly one coupon per milestone
- [ ] Committed

## 9. Admin report

Return the sales and coupon summary, consistent with the orders and coupons the API returns.

**Done when**
- [ ] `GET /admin/report` runs in REPEATABLE READ READ ONLY (§6.5)
- [ ] Includes every product (0 if unsold), gross, discount, net, coupon counts, and placed orders
- [ ] Tests pass:
  - T14: report reconciles with `/admin/orders` and `/admin/coupons` after a mixed run; two calls give the same body and change no rows
- [ ] Committed

## 10. Harden with concurrency tests

Prove the invariants hold under heavy overlap, and prove the tests would catch a broken implementation.

**Done when**
- [ ] Invariant checker (T15) in `test/helpers.ts`, run at the end of every concurrency test
- [ ] `waitForLockWaiters(pool, n)` in `test/helpers.ts`:
  - polls `pg_stat_activity` until `n` backends have `wait_event_type = 'Lock'`, with a timeout
  - lets race tests set up an exact interleaving instead of sleeping
  - if task 7 needs it first, build it there and tick this item then
- [ ] Tests pass:
  - T13: 20 parallel confirms with n = 5 give placement numbers 1..20 with no gaps, and exactly 4 coupons on orders 5/10/15/20
  - **Cart lock (I4), deterministic:**
    - a separate connection opens a transaction, locks the cart `FOR UPDATE`, and sets it to `CHECKED_OUT` (simulating an in-flight confirm)
    - a `PUT` on that cart is started and confirmed blocked with `waitForLockWaiters`
    - the blocker commits; the `PUT` returns 409 `CART_ALREADY_CHECKED_OUT` and the line is unchanged
    - why this test exists: the task 5 parallel-PUT test passes even without the cart lock (the version increment is atomic and different products don't conflict), so it doesn't prove I4
  - `PUT` with `quantity: 0` on an unknown product returns 404 `PRODUCT_NOT_FOUND` (pins the documented PUT-0 vs DELETE asymmetry; DELETE returns a 200 no-op)
- [ ] Fix the `bumpVersion` doc comment in `src/modules/carts/service.ts`: it bumps unconditionally, and the caller checks `rowCount`
- [ ] Make `insertOrderFixture` (in `test/helpers.ts`) a coherent order, so the T15 invariant checker and T14 report reconciliation hold with fixtures present:
  - one `order_lines` row: `sku-sticker-pack`, quantity 1, at its current price
  - order and quote totals computed from that line, plus the matching `quote_lines` row
  - that product's stock decremented by 1 in the same transaction
  - why: today the fixture order has `subtotal_paise = 100` and no lines, which breaks "subtotal = Σ line totals" and "stock + sold = seed stock"
  - do this before writing the T15 checker; if task 7 or 9 tests trip on it first, fix it there and tick this item
- [ ] Note in the `insertCouponFixture` doc comment that its milestones are not aligned with placement k × n, so it must not be used in admin-generation tests (task 8)
- [ ] Fix the `export const CartLine =Type.Object(` spacing in `src/modules/carts/schemas.ts`
- [ ] Sanity checks, done locally and not committed. For each, break the guard, confirm the named test fails, then restore it:
  - remove `FOR UPDATE` from `lockOpenCart`: the cart-lock (I4) test must fail
  - remove `AND redeemed_order_id IS NULL` from the coupon redeem: T6 must fail (two orders carry the coupon)
  - remove **both** stock defences in confirm (the under-lock stock check and `AND stock >= $qty`): T5 must fail; the `CHECK (stock >= 0)` turns the oversell into a 500 instead of a 409
  - expect layered defences: removing only one stock defence is caught by the other, and nothing should fail. Record that as intended defence in depth, not as a test gap
  - note which test caught each one, for DECISIONS §10
- [ ] Record in DECISIONS §9, as an AI suggestion that was corrected: the parallel-PUT test proposed for task 5 did not test the cart lock it was meant to prove
- [ ] Committed

## 11. Write the README and API docs

Make the service easy to run and evaluate from a fresh clone.

**Done when**
- [ ] README covers:
  - prerequisites
  - setup (`db:up`, migrate, `dev`)
  - running tests
  - configuration table
  - admin-only endpoints marked
  - links to `/docs`, SPECIFICATIONS and DECISIONS
- [ ] A copy-paste walkthrough (curl or `.http` file): cart → items → quote → confirm → replay → order → report
- [ ] OpenAPI at `/docs` lists every endpoint with request and response schemas and error codes
- [ ] Committed

## 12. Finish DECISIONS.md

Bring the decision record in line with what was actually built. This document is heavily weighted in the evaluation.

**Done when**
- [ ] Every TODO resolved; "Implemented (planned)" changed to what actually shipped
- [ ] §9 has at least one real implementation-time example of AI output that was corrected, beyond the design-phase ones; candidates so far:
  - auto-generated constraint names the probe disproved
  - the fixture coupon code containing `U`
  - the `pg_isready` socket-vs-TCP healthcheck race
- [ ] §10 updated with what the sanity check (task 10) revealed
- [ ] Approved spec edits applied (e.g. `ROUTE_NOT_FOUND`); spec and code agree
- [ ] Approximate time spent filled in
- [ ] Committed

## 13. Final check and submit

Confirm everything works for someone seeing the repo for the first time, then hand it in.

**Done when**
- [ ] Fresh clone in a new folder: `npm ci`, `db:up`, migrate, `npm test` all pass, and the README walkthrough works as written
- [ ] `git status` is clean; no `.env` or secrets committed; history reads as a sensible progression
- [ ] Anything incomplete is stated plainly in the README, with how it would be finished
- [ ] Repository public (or access granted), link shared, with the approximate time spent
