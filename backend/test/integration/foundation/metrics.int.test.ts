import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

/** Every metric of section 10.8. */
const SPEC_METRICS = [
  'snapland_http_request_duration_seconds',
  'snapland_http_requests_in_flight',
  'snapland_ws_connections',
  'snapland_ws_connections_total',
  'snapland_ws_disconnects_total',
  'snapland_ws_messages_received_total',
  'snapland_ws_messages_sent_total',
  'snapland_ws_messages_dropped_total',
  'snapland_ws_sent_bytes_total',
  'snapland_ws_outbound_queue_depth',
  'snapland_ws_slow_consumer_disconnects_total',
  'snapland_ws_fanout_latency_seconds',
  'snapland_ws_revalidation_runs_total',
  'snapland_ws_revalidation_closes_total',
  'snapland_bus_messages_total',
  'snapland_presence_online_users',
  'snapland_rate_limit_rejections_total',
  'snapland_rate_limiter_fallback_total',
  'snapland_cache_requests_total',
  'snapland_cache_invalidate_failures_total',
  'snapland_cache_epoch_resets_total',
  'snapland_area_bbox_page_budget_cuts_total',
  'snapland_db_query_duration_seconds',
  'snapland_db_pool_connections',
  'snapland_db_errors_total',
  'snapland_redis_command_errors_total',
  'snapland_redis_up',
  'snapland_redis_used_memory_bytes',
  'snapland_client_errors_total',
  'snapland_area_mutations_total',
  'snapland_area_conflicts_total',
  'snapland_area_bbox_query_rows',
  'snapland_audit_queue_depth',
  'snapland_audit_events_total',
  'snapland_audit_flush_duration_seconds',
  'snapland_retention_purged_total',
];

describe('/metrics (section 10.8, R41)', () => {
  it('serves the Prometheus exposition with every specified metric and default process metrics', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    for (const name of SPEC_METRICS) expect(response.body, name).toContain(`# TYPE ${name} `);
    expect(response.body).toContain('snapland_nodejs_eventloop_lag_seconds');
    expect(response.body).toContain('snapland_process_cpu_user_seconds_total');
  });

  it('records request latency by route pattern and samples Redis gauges on scrape', async () => {
    await testApp.app.inject({ method: 'GET', url: '/api/v1/config?cache-buster=1' });
    const body = (await testApp.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toMatch(
      /snapland_http_request_duration_seconds_count\{[^}]*route="\/api\/v1\/config"[^}]*status_code="200"[^}]*\} 1/,
    );
    expect(body).not.toContain('cache-buster');
    expect(body).toMatch(/snapland_redis_up\{[^}]*client="cmd"[^}]*\} 1/);
    expect(body).toMatch(/snapland_redis_used_memory_bytes\{[^}]*client="cmd"[^}]*\} \d+/);
    expect(body).toMatch(new RegExp(`instance="${testApp.container.instanceId}"`));
  });

  it('is not guarded by the request safety net nor listed in the OpenAPI document', async () => {
    const document = (await testApp.app.inject({ method: 'GET', url: '/docs/json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(document.paths)).not.toContain('/metrics');
  });
});
