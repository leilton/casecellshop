// k6: many clients racing for the same SKU at the same time + double click.
// Expected: accepted orders <= initial stock; same Idempotency-Key → same orderId.

import { check } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:3000';
const SKU = __ENV.SKU || 'CASE-IPH15-BLK';
const accepted = new Counter('checkout_accepted');
const rejected = new Counter('checkout_out_of_stock');

// 409 (out of stock) is a correct answer under contention, not a failure: only other statuses count as failed.
http.setResponseCallback(http.expectedStatuses(202, 409));

export const options = {
  scenarios: {
    rush: { executor: 'shared-iterations', vus: 50, iterations: 200, maxDuration: '60s' },
  },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

export default function () {
  const key = `k6-${__VU}-${__ITER}`;
  const params = { headers: { 'content-type': 'application/json', 'idempotency-key': key } };
  const body = JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] });

  // double click: two requests with the same key
  const [a, b] = http.batch([
    ['POST', `${API}/checkout`, body, params],
    ['POST', `${API}/checkout`, body, params],
  ]);

  if (a.status === 202) accepted.add(1);
  if (a.status === 409) rejected.add(1);

  check(a, { 'status 202 or 409': (r) => r.status === 202 || r.status === 409 });
  check(b, {
    'double click returns the same orderId': (r) => r.status !== 202 || r.json('orderId') === a.json('orderId'),
  });
}
