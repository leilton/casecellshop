// k6: checkout spike from many clients plus one abusive client, to measure the peak protection (ADR 0009).
// Expected: admitted checkouts (202/409) keep a bounded p95; the abusive client gets 429; excess load gets fast
// 503 OVERLOADED with Retry-After instead of slow timeouts; nothing else fails. Oversell is checked in Postgres.

import { check } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:3000';
const SKU = __ENV.SKU || 'CASE-IPH15-BLK';
const RATE = Number(__ENV.PEAK_RATE || 1500); // crowd checkouts per second at the top of the spike
const RUN = __ENV.RUN_ID || `${Date.now()}`;

const byStatus = {
  202: new Counter('checkout_202_accepted'),
  409: new Counter('checkout_409_out_of_stock'),
  429: new Counter('checkout_429_rate_limited'),
  503: new Counter('checkout_503_overloaded'),
};
const other = new Counter('checkout_unexpected');
const admitted = new Trend('checkout_admitted_duration', true);
const shedFast = new Trend('checkout_rejected_duration', true);
const limitedRate = new Rate('checkout_429_rate');
const overloadedRate = new Rate('checkout_503_rate');

// 202/409 are answers; 429/503 are the protection working. Anything else is a real failure.
http.setResponseCallback(http.expectedStatuses(202, 409, 429, 503));

export const options = {
  scenarios: {
    crowd: {
      executor: 'ramping-arrival-rate',
      exec: 'crowd',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { target: RATE, duration: '10s' },
        { target: RATE, duration: '20s' },
        { target: 0, duration: '5s' },
      ],
    },
    abuser: {
      executor: 'constant-arrival-rate',
      exec: 'abuser',
      rate: 20,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 10,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checkout_unexpected: ['count==0'],
    'checkout_admitted_duration{scenario:crowd}': ['p(95)<1500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function buy(ip, key) {
  const res = http.post(`${API}/checkout`, JSON.stringify({ items: [{ sku: SKU, quantity: 1 }] }), {
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-forwarded-for': ip },
  });
  const counter = byStatus[res.status];
  if (counter) counter.add(1);
  else other.add(1);
  limitedRate.add(res.status === 429);
  overloadedRate.add(res.status === 503);
  if (res.status === 202 || res.status === 409) admitted.add(res.timings.duration);
  if (res.status === 429 || res.status === 503) {
    shedFast.add(res.timings.duration);
    check(res, { 'rejection carries Retry-After': (r) => Number(r.headers['Retry-After']) >= 1 });
  }
  return res;
}

// Each iteration is a different shopper (its own IP and Idempotency-Key), well under the per-client budget.
export function crowd() {
  const n = __VU * 100000 + __ITER;
  buy(`10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`, `peak-${RUN}-${n}`);
}

// One client looping far above its budget: 20/s against a default of 20 per 10 s.
export function abuser() {
  buy('203.0.113.66', `abuser-${RUN}-${__VU}-${__ITER}`);
}
