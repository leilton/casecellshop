---
name: new-module
description: Scaffold a new domain module under src/modules/<name> (routes, service, repository, schemas, test) following the project layout. Use when adding a new bounded area such as catalog, checkout, orders or invoicing.
---

# New module

Input: module name in kebab-case (e.g. `checkout`).
1. Confirm you are on a `feature/*` branch (not `main`/`develop`).
2. Create `src/modules/<name>/` with:
   - `schemas.ts` — Zod schemas and `z.infer` types. Named exports.
   - `repository.ts` — `create<Name>Repository(db: Pool)` returning an object of async functions with
     parameterized SQL only. No business rules.
   - `service.ts` — `create<Name>Service(deps)` where `deps` holds the repository and clients
     (redis, sqs, erp, metrics, logger). No Fastify or `pg` types.
   - `routes.ts` — `export const <name>Routes: FastifyPluginAsync<{ service: <Name>Service }>`; validates with
     `schemas.ts`, calls the service, maps `AppError` via the global handler.
   - `<name>.test.ts` — Vitest unit test of the service using in-memory fakes.
3. Register the plugin in `src/api/server.ts` (after the `tracing` import, which stays first).
4. If the module adds metrics, define them in `src/shared/metrics.ts` using the README contract names.
5. Run `npm run check && npm test`.
6. Commit: `feat(<name>): scaffold <name> module`.

Keep all code and comments in English. Follow `.claude/rules/typescript.md` and the dependency direction
`routes → service → repository`.
