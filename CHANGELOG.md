# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-22

### Added

- Local environment: Docker Compose with API/worker placeholders, ERP mock, Postgres, Redis, ElasticMQ,
  OpenTelemetry Collector, Jaeger, Prometheus, Grafana and k6.
- Postgres schema (products, inventory, orders, outbox, order_events) and seed.
- Prometheus alert rules and metrics contract.
- Project conventions: CLAUDE.md, Claude rules and skills, CONTRIBUTING.md (Git flow), ADRs, runbooks,
  Biome, husky and commitlint.
