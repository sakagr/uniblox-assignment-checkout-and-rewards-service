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
| 7 | Place orders (confirm checkout) | 75 min | ✅ Done |
| 8 | Admin coupons and order list | 30 min | ✅ Done |
| 9 | Admin report | 20 min | ✅ Done |
| 10 | Harden with concurrency tests | 50 min | ✅ Done |
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
- [x] `src/http/error-handler.ts`: envelope for domain errors, validation errors (400), transient pg errors (503) and unknown errors (500); `ROUTE_NOT_FOUND` for unknown routes (added to SPECIFICATIONS §5.4 in task 7)
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

## 7. Place orders (confirm checkout) ✅

Turn a quote into an order exactly as quoted. This is the core of the assignment: idempotent retries, no overselling, single coupon redemption, gapless placement numbers, and the milestone coupon.

**Done when**
- [x] `POST /carts/:cartId/checkout` follows §6.3 step by step, in the D9 lock order
- [x] Replay: same quote on a checked-out cart gives 200 with `Idempotent-Replayed: true` and an identical body; a different quote gives 409
- [x] Stale quote: version mismatch gives `QUOTE_STALE` / `CART_CHANGED`; price mismatch (checked after the product locks) gives `PRICE_CHANGED` with a per-line diff
- [x] Coupon redeemed by conditional update; stock decremented by conditional update; counter incremented last
- [x] Order and line snapshots inserted; cart set to `CHECKED_OUT`; milestone coupon auto-generated with `ON CONFLICT (milestone) DO NOTHING` when enabled
- [x] `GET /orders/:orderId` returns the §5.2 Order shape, including `couponApplied` and `earnedCoupon`
- [x] After confirm, `GET /carts/{id}` returns `CHECKED_OUT` and `orderId` equal to the created order
- [x] Make `insertOrderFixture` (in `test/helpers.ts`) a coherent order, so the T15 invariant checker and T14 report reconciliation hold with fixtures present:
  - one `order_lines` row: `sku-sticker-pack`, quantity 1, at its current price
  - order and quote totals computed from that line, plus the matching `quote_lines` row
  - that product's stock decremented by 1 in the same transaction
  - why: today the fixture order has `subtotal_paise = 100` and no lines, which breaks "subtotal = Σ line totals" and "stock + sold = seed stock"
- [x] Tests pass:
  - T4: 10 parallel confirms of one quote give one order
  - T5: oversell race on the stock-2 product
  - T6: coupon race
  - T7: coupon survives a failed checkout
  - T8 and T9: stale quotes
  - T10: order history survives a price change
  - T11: auto coupon on the nth order
- [x] Committed in increments (happy path first, then each failure mode with its test)

## 8. Admin coupons and order list ✅

Give the administrator manual coupon generation (a backfill for missed milestones) and listing endpoints for reconciliation.

**Done when**
- [x] `POST /admin/coupons` follows §6.4: locks the counter, picks the lowest unrewarded milestone, links it to the milestone order, returns `pendingMilestones`; 409 `NO_ELIGIBLE_MILESTONE` with details otherwise
- [x] `GET /admin/coupons?status=` and `GET /admin/orders`
- [x] Tests pass:
  - [x] T12: 10 parallel generate calls with auto-generation off give exactly one coupon per milestone
  - [x] T11 remainder: after an auto-generated coupon, `POST /admin/coupons` returns 409 `NO_ELIGIBLE_MILESTONE` (the part of T11 that needs this endpoint)
  - [x] With auto-generation off, an admin backfill of a milestone makes `GET /orders/:id` for the milestone order show `earnedCoupon` (it was `null` before; task 7 pins the `null` side)
- [x] Committed

## 9. Admin report ✅

Return the sales and coupon summary, consistent with the orders and coupons the API returns.

**Done when**
- [x] `GET /admin/report` runs in REPEATABLE READ READ ONLY (§6.5)
- [x] Includes every product (0 if unsold), gross, discount, net, coupon counts, and placed orders
- [x] Tests pass:
  - T14: report reconciles with `/admin/orders` and `/admin/coupons` after a mixed run; two calls give the same body and change no rows
- [x] Committed

## 10. Harden with concurrency tests ✅

Prove the invariants hold under heavy overlap, and prove the tests would catch a broken implementation.

**Done when**
- [x] Invariant checker (T15) in `test/helpers.ts`, run at the end of every concurrency test
- [x] `waitForLockWaiters(pool, n)` in `test/helpers.ts`:
  - polls `pg_stat_activity` until `n` backends have `wait_event_type = 'Lock'`, with a timeout
  - lets race tests set up an exact interleaving instead of sleeping
  - if task 7 needs it first, build it there and tick this item then
- [x] Tests pass:
  - [x] T13: 20 parallel confirms with n = 5 give placement numbers 1..20 with no gaps, and exactly 4 coupons on orders 5/10/15/20
  - [x] **Cart lock (I4), deterministic:**
    - a separate connection opens a transaction, locks the cart `FOR UPDATE`, and sets it to `CHECKED_OUT` (simulating an in-flight confirm)
    - a `PUT` on that cart is started and confirmed blocked with `waitForLockWaiters`
    - the blocker commits; the `PUT` returns 409 `CART_ALREADY_CHECKED_OUT` and the line is unchanged
    - why this test exists: the task 5 parallel-PUT test passes even without the cart lock (the version increment is atomic and different products don't conflict), so it doesn't prove I4
  - [x] `PUT` with `quantity: 0` on an unknown product returns 404 `PRODUCT_NOT_FOUND` (pins the documented PUT-0 vs DELETE asymmetry; DELETE returns a 200 no-op)
- [x] Fix the `bumpVersion` doc comment in `src/modules/carts/service.ts`: it bumps unconditionally, and the caller checks `rowCount`
- [x] Note in the `insertCouponFixture` doc comment that its milestones are not aligned with placement k × n, so it must not be used in admin-generation tests (task 8)
- [x] Fix the `export const CartLine =Type.Object(` spacing in `src/modules/carts/schemas.ts`
- [x] Sanity checks, done locally and not committed. For each, break the guard, confirm the named test fails, then restore it:
  - [x] remove `FOR UPDATE` from `lockOpenCart`: the cart-lock (I4) test must fail. **The I4 test failed** (the PUT returned 200 instead of 409; the other 16 tests in `cart.test.ts` still passed, which is the point of the test). The T4 run in task 7 covers confirm's cart lock, not item edits
  - [x] remove `AND redeemed_order_id IS NULL` from the coupon redeem: **T6 failed**, as intended (done in task 7)
  - [x] remove **both** stock defences in confirm (the under-lock stock check and `AND stock >= $qty`): **T5 failed**, as intended (done in task 7)
  - [x] swap the PRICE_CHANGED and INSUFFICIENT_STOCK checks: the precedence test ("reports PRICE_CHANGED before INSUFFICIENT_STOCK when both apply") failed, as intended (done in task 7)
  - [x] remove the cart `FOR UPDATE` in confirm: **T4 failed** (no replays), as intended (done in task 7)
  - [x] remove only `AND p.stock >= v.qty` from confirm's guarded decrement: **all 137 tests still pass**, as intended. The under-lock stock check (step 6) throws first, and `CHECK (stock >= 0)` sits behind both. This is defence in depth, not a test gap. Only removing **both** application guards (T5 above) is caught
  - [x] remove `FOR UPDATE` from the `store_stats` read in `generateMilestoneCoupon` (done in the tasks 8/9 session): **T12 failed**. Over 3 runs of `coupons.test.ts`, each run had 2 × 201; run 1 also had 1 × 409 + 7 × 500, runs 2 and 3 had 8 × 500. Every 500 was SQLSTATE 23505 on `coupons_milestone_key` (none on `coupons_milestone_order_id_key`), and T12 failed on its status-code assertions each time
  - [x] note which test caught each one, for DECISIONS §10:

    | Guard removed | Task | Caught by |
    |---|---|---|
    | `AND redeemed_order_id IS NULL` on the coupon redeem | 7 | T6 |
    | both stock defences in confirm (under-lock check and `AND stock >= $qty`) | 7 | T5 |
    | PRICE_CHANGED / INSUFFICIENT_STOCK check order swapped | 7 | "reports PRICE_CHANGED before INSUFFICIENT_STOCK when both apply" |
    | cart `FOR UPDATE` in confirm | 7 | T4 (no replays) |
    | `FOR UPDATE` on the `store_stats` read in admin generation | 8 | T12 (status codes; 500s were 23505 on `coupons_milestone_key`) |
    | `FOR UPDATE` in `lockOpenCart` | 10 | I4 cart-lock test (`200` instead of `409`; the parallel-PUT test still passed) |
    | `AND p.stock >= v.qty` alone | 10 | **nothing, by design** (defence in depth) |
- [x] Committed

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
- [x] OpenAPI at `/docs` lists every endpoint with request and response schemas and error codes
- [ ] Committed

## 12. Finish DECISIONS.md

Bring the decision record in line with what was actually built. This document is heavily weighted in the evaluation.

**Done when**
- [ ] Every TODO resolved; "Implemented (planned)" changed to what actually shipped
- [ ] §9 has at least one real implementation-time example of AI output that was corrected, beyond the design-phase ones; candidates so far:
  - auto-generated constraint names the probe disproved
  - the fixture coupon code containing `U`
  - the `pg_isready` socket-vs-TCP healthcheck race
  - **the parallel-PUT test proposed for task 5 did not test the cart lock it was meant to prove** (it passes without `FOR UPDATE`; the deterministic I4 test in task 10 replaced it as the proof)
  - **a sanity check that gave a false result:** the first attempt at the task 8 counter-lock check used `-t "T12"`, which skipped the order-placing setup tests and gave a false result. Running the whole file gave the real result (T12 fails on status codes, with 23505 on `coupons_milestone_key`)
- [ ] §10 updated with the sanity-check results (task 10 table: which test caught each guard, and the one that deliberately catches nothing)
- [ ] Approved spec edits applied (`ROUTE_NOT_FOUND` was already added to §5.4 in task 7); spec and code agree
- [ ] Correct the D6 and §4 wording on the counter lock (propose the edits, per AGENTS.md):
  - MVCC visibility is what stops admin pre-empting an in-flight milestone confirm: admin sees only committed placements
  - the counter lock serializes admin calls into clean 409s, and makes admin wait for in-flight confirms
- [ ] A DECISIONS entry for the container runtime (task 11 commit `build: run the app in a container`):
  - tsx in the image rather than compiled `dist/`: `tsc` emits `migrate.js` under `dist/src/db`, where the `../../migrations/` lookup resolves to the wrong place
  - devDependencies kept in the image, so tsx can run the app and vitest can run the suite in the container (`npm run test:docker`)
  - migrations run on every container start; safe because they hold a Postgres advisory lock and are idempotent (`schema_migrations`)
  - `exec` into tsx with `init: true`, not `npm start`, so SIGTERM reaches the server and graceful shutdown runs (stop measured at ~0.3s, exit 0)
  - the lockfile is portable: the suite passed as `linux/amd64` (vite 8 bundles with Rolldown, not Rollup; its `@rolldown/binding-linux-*-musl` and the `esbuild` Linux packages are in the lockfile)
- [ ] Approximate time spent filled in
- [ ] Committed

## 13. Final check and submit

Confirm everything works for someone seeing the repo for the first time, then hand it in.

**Done when**
- [ ] Fresh clone in a new folder: `npm ci`, `db:up`, migrate, `npm test` all pass, and the README walkthrough works as written
- [ ] `git status` is clean; no `.env` or secrets committed; history reads as a sensible progression
- [ ] Anything incomplete is stated plainly in the README, with how it would be finished
- [ ] Repository public (or access granted), link shared, with the approximate time spent
