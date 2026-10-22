# 0004 — Transactional outbox for checkout → queue

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

Writing the order to Postgres and publishing to SQS are two systems. Publishing inside the request can leave
an order without a message (crash after commit) or a message without an order (rollback after send).

## Decision

`POST /checkout` writes the order, the reservation and an `outbox` row in one transaction. A relay in the worker
reads unpublished rows with `FOR UPDATE SKIP LOCKED`, sends them to SQS and sets `published_at`.

## Consequences

- No ghost orders or ghost messages; the API never depends on SQS being up.
- Delivery is at-least-once, so consumers must be idempotent (see ADR 0005).
- Small extra latency between commit and enqueue (relay poll interval).
