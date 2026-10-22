# CaseCellShop

Backend for a phone-case e-commerce (senior backend challenge). The storefront reads a slow, unstable ERP
through a cache; checkout reserves stock in our own Postgres and hands invoicing to an async worker via SQS.

**Invariants — never break these:**
1. **No overselling.** Stock is reserved only by an atomic conditional `UPDATE ... WHERE available >= $q`.
2. **Idempotent checkout.** Same `Idempotency-Key` → same `orderId`; same key + different payload → `422`.
3. **Never duplicate an ERP invoice.** `POST /invoices` on the ERP is NOT idempotent: always
   `GET /invoices?orderId=` before retrying.

## Language

All code, identifiers, comments, log/error messages, docs, skills and commit messages are in **English**.
Exception: `README.pt-BR.md` is the Brazilian Portuguese translation of the README for the challenge reviewers;
the English `README.md` is the source of truth and both change in the same commit.

## Commands

```bash
make up | obs | down | reset   # core stack | + observability | stop | stop + wipe DB (re-seed)
make load                      # k6 oversell + double-click test (run after `make reset && make up`)
make chaos | calm              # degrade / restore the ERP mock
npm run check                  # biome + tsc (must pass before every commit)
npm test                       # vitest
npm run format                 # biome autofix
```
Node may not be installed on the host: `./scripts/npx.sh <cmd>` runs it in `node:22`.

## Layout

```
src/
  api/server.ts            # Fastify bootstrap; registers module plugins
  worker/index.ts          # SQS consumer + outbox relay + reconciliation
  modules/<domain>/        # catalog | checkout | orders | invoicing
    routes.ts              # Fastify plugin: HTTP only, validates with schemas.ts, calls service
    service.ts             # business rules; no Fastify/HTTP types
    repository.ts          # SQL for this module only
    schemas.ts             # Zod schemas + inferred types
    <domain>.test.ts
  shared/                  # config (Zod-validated env), db, redis, sqs, logger, metrics, errors
  observability/tracing.ts # MUST be the first import of every entrypoint
infra/                     # postgres schema+seed, sqs, otel, prometheus alerts, grafana
docs/                      # architecture, ADRs, runbooks, openapi.yaml
```
Dependency direction: `routes → service → repository / clients`. A module never imports another
module's `repository`; it calls that module's `service`.

## Conventions

- CommonJS (`module: CommonJS`) on purpose — OTel auto-instrumentation needs it (ADR 0003).
- Read env only through `src/shared/config.ts`; never `process.env` elsewhere.
- Money is integer cents (`priceCents`, `total_cents`). Never floats.
- Throw `AppError(code, httpStatus)` from `shared/errors.ts`; one Fastify error handler maps it to
  `{ "error": { "code", "message" } }`.
- Log with pino (`shared/logger.ts`), never `console.*`. Include `orderId` / `correlationId`.
- Metric names and labels are a contract with `infra/prometheus/alerts.yml` (see README table).
- Path-specific rules live in `.claude/rules/` and load automatically.

## Git flow

- Never commit on `main` or `develop`. Start work with `git switch develop && git switch -c feature/<scope>-<desc>`.
- Conventional Commits: `feat(checkout): reserve stock atomically`. Hooks enforce lint, types and message.
- Use the `git-flow` skill for releases and hotfixes. Details in `CONTRIBUTING.md`.

## Before you finish

1. `npm run check && npm test` pass.
2. New/changed endpoint → update `docs/openapi.yaml`.
3. New/changed metric → matches README table and `alerts.yml`.
4. Architectural decision → new ADR in `docs/adr/`.
5. Meaningful AI-assisted work → add a row to `PROMPTS.md` (`log-prompt` skill).

See @docs/architecture.md for the full flow.
