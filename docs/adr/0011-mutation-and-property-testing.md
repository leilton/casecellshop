# 0011 — Mutation and property testing for the invariants

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Line coverage was ~92%, but coverage only shows that a line ran, not that a test would fail if the line were
wrong. The three invariants (no overselling, idempotent checkout, never a duplicate ERP invoice) live in the
`checkout` and `invoicing` modules, plus the SQL they run. Example-based tests check the cases someone thought of.

## Decision

1. **Mutation testing with Stryker, scoped to `src/modules/checkout` and `src/modules/invoicing`** (`make mutation`).
   - `vitest.stryker.config.ts` runs only the tests that reach those modules (their unit tests, the checkout,
     invoicing, cancel and outbox integration tests, and the HTTP tests for the checkout route). `coverageAnalysis:
     perTest` runs only the covering tests for each mutant. `concurrency: 1`, because every Vitest instance's global
     setup rebuilds the shared `shop_test` database. A full run takes about 5 minutes.
   - `stryker-plugins.mjs` is an *ignorer*. It skips mutants in log statements, log-only blocks, `span.*` calls
     and `withSpan` names and attributes: they have no behaviour worth pinning down. **Metric labels are not
     ignored.** They are a contract with the alerts, so tests assert them.
   - Mutants that cannot change behaviour (lock ordering that only prevents deadlocks, `rows[0] ?? row` after an
     UPDATE of a locked row, defensive branches) are marked with `// Stryker disable next-line <mutator>: <reason>`.
     A reason is mandatory.
   - `thresholds.break: 95`: the run fails if the score drops below 95%. In CI it is a manual (`workflow_dispatch`)
     job, too slow for every push. The HTML report is uploaded as an artifact.
2. **Property-based testing with fast-check** for the reservation, against the real database
   (`tests/integration/checkout.property.test.ts`). It generates random stock, concurrent carts in any SKU order,
   double clicks and cancels, and checks that stock never goes negative, `available + reserved` is conserved,
   `reserved` equals the live orders, one key maps to one order, and the only failure is `409`. Failures print a
   seed and a shrunk counterexample. A deliberately broken release was caught and shrunk to one unit, one order
   and one cancel.

## Consequences

- The first run scored **69.9%**. Its survivors were real gaps that had no failing test. Adopting an invoice twice,
  or releasing a settled order again, would have changed stock or history. A bug in the ERP client would have been
  treated as an ERP outage and failed the order. Metric labels, user-facing messages and event details were not
  asserted. Tests now cover all of them, and the score is **100%** (441/441, 76 ignored).
- Stryker does not mutate inside SQL strings, for example `available >= $2`. The SQL invariants are guarded by the
  integration tests, the fast-check property and the `CHECK` constraints, not by mutation testing.
- The property found one subtlety. The remaining stock in a `409` is read after the failed `UPDATE`, so a cancel
  committing in between can make it larger than what was asked. It is documented as advisory, and the property only
  asserts `available < requested` in runs without cancels.
- A change in `checkout` or `invoicing` that leaves a new survivor fails `make mutation` once the score goes below
  95%. It has to be fixed with a test, or with a justified disable comment.
