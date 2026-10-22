// Imported as the FIRST line of every entrypoint. Auto-instruments http, fastify, pg, ioredis and aws-sdk.
// Business spans (cache.get, stock.reserve, erp.invoice) must be created manually with @opentelemetry/api.

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(), // uses OTEL_EXPORTER_OTLP_ENDPOINT
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
});

sdk.start();
process.on('SIGTERM', () => void sdk.shutdown());
