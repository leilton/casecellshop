# Architecture Decision Records

Short records in the format **Context / Decision / Consequences**. File name: `NNNN-kebab-title.md`.
Never edit an accepted ADR's decision — supersede it with a new one and set `Status: Superseded by NNNN`.

| #                                         | Title                                 | Status   |
| ----------------------------------------- | ------------------------------------- | -------- |
| [0001](0001-postgres-as-shop-database.md) | Postgres as the shop's own database   | Accepted |
| [0002](0002-elasticmq-as-local-sqs.md)    | ElasticMQ as the local SQS            | Accepted |
| [0003](0003-commonjs-for-otel.md)         | CommonJS modules for OpenTelemetry    | Accepted |
| [0004](0004-transactional-outbox.md)      | Transactional outbox                  | Accepted |
| [0005](0005-idempotency-strategy.md)      | Idempotency at checkout and invoicing | Accepted |
