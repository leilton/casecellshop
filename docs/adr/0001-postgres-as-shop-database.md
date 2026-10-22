# 0001 — Postgres as the shop's own database

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

The ERP's MySQL is read-only and off-limits. We need our own store for the storefront read model,
stock reservations, orders and the outbox, with strong guarantees against overselling.

## Decision

Use Postgres 16. Rely on `CHECK (available >= 0)`, conditional `UPDATE ... RETURNING` for atomic reservations,
partial indexes (`outbox WHERE published_at IS NULL`) and `FOR UPDATE SKIP LOCKED` for the relay.

## Consequences

- Reservations are a single atomic statement; the CHECK is a last line of defense.
- Two databases (ERP MySQL + shop Postgres) must be reconciled; the ERP stays the fiscal source of truth.
