# 0003 — CommonJS modules for OpenTelemetry auto-instrumentation

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

OpenTelemetry auto-instrumentation patches modules (`http`, `fastify`, `pg`, `ioredis`, `aws-sdk`) through
`require` hooks. With ESM it needs the experimental `--import`/loader hooks, which are fragile with `tsx watch`.

## Decision

Compile and run as CommonJS (`"module": "CommonJS"`). `src/observability/tracing.ts` is the first import of every
entrypoint, so instrumentation is registered before the libraries load.

## Consequences

- Auto-instrumentation works with no loader flags in dev and prod.
- Some ESM-only packages can't be used directly; prefer packages that ship CJS.
