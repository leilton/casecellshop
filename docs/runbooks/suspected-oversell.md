# Runbook — Suspected overselling

**Alert:** `PossibleOverselling`

## Symptoms

`inventory_available < 0` (should be impossible due to the CHECK) or a spike in
`stock_reservation_conflicts_total`.

## Diagnose

1. `SELECT sku, available, reserved FROM inventory ORDER BY available;`
2. Compare `sum(items.quantity)` of non-cancelled orders per SKU with the initial stock.
3. A conflict spike alone is expected during a rush (many clients, little stock) — it means the guard works.

## Act

- If counts don't add up, look for code paths that write `inventory` outside the conditional `UPDATE`.
- Cancel the extra orders (newest first), release their reservations and record `order_events`.
