# 0002 — ElasticMQ as the local SQS

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

Checkout must hand invoicing to an async worker with retries and a DLQ, and the environment must be 100% local
(no cloud accounts).

## Decision

Use ElasticMQ, which implements the SQS API including redrive to a DLQ, starts in about a second and needs no
token. The code uses `@aws-sdk/client-sqs`, so it runs unchanged on LocalStack or AWS by changing `SQS_ENDPOINT`.

## Consequences

- Same client code locally and in production.
- ElasticMQ is not a full AWS emulator; only SQS behavior is covered.
