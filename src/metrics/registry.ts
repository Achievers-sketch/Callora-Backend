import client from 'prom-client';

const billingDeductDuration = new client.Histogram({
  name: 'billing_deduct_duration_seconds',
  help: 'Latency of POST /api/billing/deduct in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function recordBillingDeductDuration(statusCode: number, durationMs: number): void {
  billingDeductDuration.observe(
    { route: '/api/billing/deduct', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function resetBillingDeductMetrics(): void {
  billingDeductDuration.reset();
}

// New credits endpoint histogram
const creditsDuration = new client.Histogram({
  name: 'api_credits_request_duration_seconds',
  help: 'Latency of GET /api/billing/credits in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/** Record duration for credits endpoint */
export function recordCreditsDuration(statusCode: number, durationMs: number): void {
  creditsDuration.observe({ route: '/api/billing/credits', status_code: String(statusCode) }, durationMs / 1000);
}

export { billingDeductDuration, creditsDuration };
