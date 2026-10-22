---
paths:
  - "src/**/*.ts"
---

# TypeScript

- All code, identifiers, comments and messages in English.
- `strict` is on. No `any` — use `unknown` and narrow with Zod or type guards.
- Use `import type` for type-only imports (Biome enforces `useImportType`).
- Named exports only. Default exports are allowed only where a library requires them.
- No non-null assertions (`!`) on env or I/O values — validate in `shared/config.ts` instead.
- Keep `service.ts` free of Fastify, `pg` and `ioredis` types: inject repositories/clients as parameters
  so services are unit-testable with fakes.
- Prefer `async/await`; never leave a floating promise (use `void` explicitly for fire-and-forget loops).
- Constants and tunables (TTLs, timeouts, attempts) come from config, not magic numbers.
- Comments explain _why_ (a trade-off, an invariant), not _what_ the next line does.
