-- The shop's own database. The ERP remains the fiscal source of truth;
-- this holds the storefront read model, stock reservations, orders and the outbox.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Storefront read model, synced from the ERP (job/CDC). version/synced_at allow measuring staleness.
CREATE TABLE products (
  sku          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
  version      INTEGER NOT NULL DEFAULT 1,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sellable stock. The CHECK is the last line of defense against overselling;
-- a reservation is an atomic conditional UPDATE:
--   UPDATE inventory SET available = available - $q, reserved = reserved + $q
--   WHERE sku = $sku AND available >= $q RETURNING available;
CREATE TABLE inventory (
  sku        TEXT PRIMARY KEY REFERENCES products(sku),
  available  INTEGER NOT NULL CHECK (available >= 0),
  reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE order_status AS ENUM ('PENDING', 'RESERVED', 'INVOICING', 'INVOICED', 'FAILED', 'CANCELLED');

CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT NOT NULL UNIQUE,      -- double click / client retry
  request_hash     TEXT NOT NULL,             -- same key + different payload → 422
  status           order_status NOT NULL DEFAULT 'PENDING',
  items            JSONB NOT NULL,
  total_cents      INTEGER NOT NULL,
  erp_invoice_id   TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  correlation_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reserved_until   TIMESTAMPTZ,   -- reservation expiry (reconciliation releases it)
  -- Short lease taken by the worker while it calls the ERP: a concurrent duplicate delivery backs off
  -- instead of looking up (finding nothing yet) and creating a second invoice.
  invoicing_lease_until TIMESTAMPTZ
);
CREATE INDEX orders_status_updated_idx ON orders (status, updated_at);

-- Transactional outbox: written in the SAME transaction as the order.
-- A relay publishes to the queue and sets published_at → no ghost order and no ghost message.
CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  aggregate_id  UUID NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Per-order history for auditing/traceability
CREATE TABLE order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id),
  from_status order_status,
  to_status   order_status NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed aligned with erp-mock
INSERT INTO products (sku, name, price_cents) VALUES
  ('CASE-IPH15-BLK', 'iPhone 15 Case Black', 4990),
  ('CASE-IPH15-CLR', 'iPhone 15 Case Clear', 3990),
  ('CASE-S24-BLU',   'Galaxy S24 Case Blue', 4590),
  ('CASE-S24-RED',   'Galaxy S24 Case Red', 4590),
  ('CASE-PX8-GRN',   'Pixel 8 Case Green', 5290);

INSERT INTO inventory (sku, available) VALUES
  ('CASE-IPH15-BLK', 10),
  ('CASE-IPH15-CLR', 50),
  ('CASE-S24-BLU',   3),
  ('CASE-S24-RED',   0),
  ('CASE-PX8-GRN',   25);
