# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Copilot, ...) working in this repository.

## What this is

A take-home assignment: the backend for a checkout and rewards service.
- Customers build carts, get a checkout quote, and confirm it to place an order.
- Every nth placed order makes an x% coupon available.
- The evaluation focuses on **correctness under retries and concurrency**, not CRUD volume.

Assignment brief: https://github.com/neustackapp/assignment/tree/main/be

## Sources of truth (read before changing anything)

| File | Role |
|---|---|
| `SPECIFICATIONS.md` | The contract: config, DDL, API shapes, status and error codes, SQL for each critical path, layout, test plan (T1–T15). |
| `DECISIONS.md` | The rationale: invariants I1–I12, ambiguities and chosen semantics, decisions D1–D11. |
| `ROADMAP.md` | The task list. Work on one task at a time, in order. |

If code and spec disagree, the spec wins until the human approves a change.
- **Never edit `SPECIFICATIONS.md` or `DECISIONS.md` on your own.** Propose the exact edits and wait.
- If the spec looks wrong or unworkable, **stop and say so** instead of quietly deviating.

## Stack

- TypeScript (strict, ESM, Node ≥ 20.6).
- Fastify 5 with the TypeBox type provider, `@fastify/swagger` and `@fastify/swagger-ui`.
- PostgreSQL 16 via docker-compose (OrbStack on macOS), accessed with raw `pg`.
- Vitest.
- **Not used:** no ORM, no query builder, no money library, no lodash, no dotenv.

## Commands

```bash
npm run db:up            # start Postgres (waits for healthy)
npm run db:migrate       # apply pending migrations to checkout
npm run db:migrate:test  # same, against checkout_test
npm run db:reset         # drop schema public and re-apply everything
npm run db:psql          # psql inside the container
npm run typecheck
npm test                 # vitest run (needs Postgres up)
npm run dev              # tsx watch src/server.ts
```

## Rules that protect the invariants

**Transactions**
- Every write path runs through `withTransaction(pool, fn, { isolation })` from `src/db/tx.ts`.
- **Never** call `pool.query` inside a transaction. Use the client passed to `fn`.
- Isolation levels:
  - READ COMMITTED for item edits, confirm and admin coupon generation.
  - REPEATABLE READ for quotes.
  - REPEATABLE READ READ ONLY for the report.

**Locking**
- The global lock order (D9) is **cart → coupon → products (sorted by id) → store_stats**. Any new path touching these rows must follow it.

**Contended resources** (stock, coupon redemption)
- Guard every change with a **conditional update**, e.g. `... WHERE stock >= $qty` or `... WHERE redeemed_order_id IS NULL`, and check `rowCount`.
- Never read, check in JS, then write.

**Confirm checkout**
- Compare quoted prices **after** taking the product `FOR UPDATE` locks, never before.

**Money**
- All money is **integer paise**, using the branded `Paise` type from `src/domain/money.ts`.
- All totals go through `calculateTotals()`. No floats, and no money maths outside that module.
- `pg` int8 and numeric values arrive through the safe-integer parsers in `src/db/pool.ts`. Never `parseInt` or `Number()` them ad hoc.

**Orders and quotes**
- Both are insert-only. No code path updates or deletes them.

**Errors**
- Throw `DomainError` factories from `src/domain/errors.ts`, using the codes in SPECIFICATIONS §5.4.
- Every response error uses the envelope `{ error: { code, message, details } }`.
- Don't invent new codes without flagging them.

**Validation**
- Ajv runs with `coerceTypes: false` and `removeAdditional: false`.
- Every body schema sets `additionalProperties: false`.
- Don't weaken either setting. Tests rely on `"5"` being rejected for an integer.

**Constraint names**
- Multi-column CHECKs have explicit names (e.g. `orders_total_consistent`). When adding one, name it.
- Code and tests may refer to constraints by name, so never rely on auto-generated `*_check1` names.

**Schema changes**
- Committed migrations are never edited. Add a new numbered file in `migrations/`.

## Testing rules

- Tests run against a **real Postgres** (`TEST_DATABASE_URL`). Each test file resets the schema in `beforeAll` via `migrate(url, { reset: true })`.
- Test files run sequentially (`fileParallelism: false`). Concurrency happens *inside* a test, with `Promise.all` over `app.inject()`.
- Keep `PG_POOL_MAX` at or above the fan-out so that transactions genuinely overlap.
- Every concurrency test ends with the invariant checker from `test/helpers.ts`.
- Prefer a few meaningful tests over many shallow ones. A test must be able to fail on a wrong implementation.
- When asserting on a constraint violation, assert the **SQLSTATE and constraint name**. A test that passes for the wrong reason is a bug.

## Workflow

1. **Before starting:** read the task in `ROADMAP.md` and the spec sections it references. Inspect the repo, and state your plan briefly.
2. **Implement:** keep changes within the task's scope. No speculative abstractions and no placeholder modules.
3. **Verify:** run `npm run typecheck` and `npm test`, and show the output. For DB behaviour, show the evidence (query results, SQLSTATEs), not just "it works".
4. **Commit:**
   - Use conventional commits.
   - Make meaningful increments. The history is part of the evaluation.
   - Never commit `.env`.
5. **Update `ROADMAP.md`:** tick the items you completed, in the same commit as the work.
6. **Report and stop:**
   - Summarise the files changed, the verification results, and anything surprising.
   - List proposed spec or decision edits.
   - **Explicitly call out any place where your earlier output, or a suggestion you received, turned out to be wrong and was corrected.** The human records these in DECISIONS §9.
   - Then stop. The next task is a separate request.
