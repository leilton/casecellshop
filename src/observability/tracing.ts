// Imported as the FIRST line of every entrypoint. Auto-instruments http, fastify, pg, ioredis and aws-sdk.
// Business spans (cache.get, stock.reserve, erp.invoice) must be created manually with @opentelemetry/api.
// Reads process.env directly on purpose: it must run before any other module, including shared/config.

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

// Spans, context propagation and trace ids in logs work without an exporter. Exporting only when a collector
// is actually running matters: every failed export resolves an unknown host, each lookup blocks one of the
// four libuv threadpool threads for ~10s, and that starved `dns.lookup` for the ERP (intermittent 2s timeouts).
const exportTraces = (process.env.OTEL_TRACES_EXPORTER ?? 'otlp') !== 'none';

const sdk = new NodeSDK({
  ...(exportTraces ? { traceExporter: new OTLPTraceExporter() } : {}), // uses OTEL_EXPORTER_OTLP_ENDPOINT
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
});

sdk.start();
process.on('SIGTERM', () => void sdk.shutdown());
