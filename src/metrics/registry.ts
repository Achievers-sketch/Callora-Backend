import client from 'prom-client';

const billingDeductDuration = new client.Histogram({
  name: 'billing_deduct_duration_seconds',
  help: 'Latency of POST /api/billing/deduct in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const refreshTokenDuration = new client.Histogram({
  name: 'refresh_token_duration_seconds',
  help: 'Latency of POST /api/refresh-token in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Histogram for /api/apis latency (FWC26 issue #893).
 *
 * Buckets chosen for marketplace listing operations:
 *   - Finer granularity at 1–50ms (typical in-process reads, cache hits)
 *   - Wider buckets beyond 50ms (DB reads, network I/O)
 *   - Tail capture up to 10s (slow clients, downstream delays)
 *
 * The /api/apis routes (GET list, GET detail, POST create) combine cache hits
 * (typically <5ms) and DB/service calls (typically 10–100ms), so the bucket
 * distribution favors visibility in the common range while preserving SLO tail metrics.
 */
const apisLatencyDuration = new client.Histogram({
  name: 'apis_request_duration_seconds',
  help: 'Latency of /api/apis requests in seconds (FWC26 issue #893)',
  labelNames: ['route', 'method', 'status_code'],
  buckets: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function recordBillingDeductDuration(statusCode: number, durationMs: number): void {
  billingDeductDuration.observe(
    { route: '/api/billing/deduct', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function recordRefreshTokenDuration(statusCode: number, durationMs: number): void {
  refreshTokenDuration.observe(
    { route: '/api/refresh-token', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

/**
 * Record a latency observation for an /api/apis request.
 *
 * @param method – HTTP verb (GET, POST)
 * @param statusCode – Response status code
 * @param durationMs – Elapsed time in milliseconds
 */
export function recordApisLatency(method: string, statusCode: number, durationMs: number): void {
  apisLatencyDuration.observe(
    { route: '/api/apis', method: method.toUpperCase(), status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function resetBillingDeductMetrics(): void {
  billingDeductDuration.reset();
}

export function resetRefreshTokenMetrics(): void {
  refreshTokenDuration.reset();
}

const maintenanceDuration = new client.Histogram({
  name: 'maintenance_duration_seconds',
  help: 'Latency of GET /api/maintenance in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function recordMaintenanceDuration(statusCode: number, durationMs: number): void {
  maintenanceDuration.observe(
    { route: '/api/maintenance', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function resetMaintenanceMetrics(): void {
  maintenanceDuration.reset();
}

export { billingDeductDuration, refreshTokenDuration, maintenanceDuration };
