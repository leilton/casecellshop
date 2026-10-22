import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError } from 'fastify';
import { catalogRoutes } from '../modules/catalog/routes';
import type { CatalogService } from '../modules/catalog/service';
import { checkoutRoutes } from '../modules/checkout/routes';
import type { CheckoutService } from '../modules/checkout/service';
import { ordersRoutes } from '../modules/orders/routes';
import type { OrdersService } from '../modules/orders/service';
import { currentContext, runWithContext } from '../shared/context';
import { AppError, type ErrorCode, isConnectionError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import { httpRequestDuration, registry } from '../shared/metrics';

export type DependencyStatus = Record<string, 'ok' | string>;

export interface AppDeps {
  logger: Logger;
  catalog: CatalogService;
  checkout: CheckoutService;
  orders: OrdersService;
  health: () => Promise<DependencyStatus>;
  openApiPath?: string;
}

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** A valid client-supplied id is kept so a trace can start upstream; anything else gets a fresh one. */
function resolveCorrelationId(headers: IncomingHttpHeaders): string {
  const incoming = headers[CORRELATION_HEADER];
  return typeof incoming === 'string' && CORRELATION_ID_PATTERN.test(incoming) ? incoming : randomUUID();
}

function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Maps Fastify's own client errors (body parsing, content type) onto the API error contract. */
function fromFastifyError(err: FastifyError): { status: number; code: ErrorCode; message: string } | undefined {
  switch (err.code) {
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' };
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return { status: 400, code: 'INVALID_JSON', message: 'Body is not valid JSON' };
  }
  if (err instanceof SyntaxError && err.statusCode === 400) {
    return { status: 400, code: 'INVALID_JSON', message: 'Body is not valid JSON' };
  }
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return { status: err.statusCode, code: 'VALIDATION_ERROR', message: err.message };
  }
  return undefined;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => randomUUID(),
    // Fastify logs "incoming request" before any hook runs, so the correlation context has to exist before
    // Fastify's handler is called; otherwise that first line is the only one without a correlationId.
    serverFactory: (handler) =>
      http.createServer((req, res) => {
        runWithContext({ correlationId: resolveCorrelationId(req.headers) }, () => handler(req, res));
      }),
  });

  // The API only speaks JSON; without Fastify's default text/plain parser such bodies get a clear 415.
  app.removeContentTypeParser('text/plain');

  // The rest of the request lifecycle runs inside the correlation context, so logs, ERP calls and the outbox
  // all see the same correlationId without passing it around. The server factory normally created it already;
  // without it (e.g. `app.inject` in tests) it is created here.
  app.addHook('onRequest', (req, reply, done) => {
    const existing = currentContext();
    const correlationId = existing?.correlationId ?? resolveCorrelationId(req.headers);
    reply.header(CORRELATION_HEADER, correlationId);
    if (existing) {
      existing.requestId = req.id;
      done();
      return;
    }
    runWithContext({ correlationId, requestId: req.id }, done);
  });

  app.addHook('onResponse', (req, reply, done) => {
    // Route pattern, never the concrete URL: one series per endpoint, not per orderId.
    const route = req.routeOptions.url ?? 'unmatched';
    httpRequestDuration.observe(
      { route, method: req.method, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    done();
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      if (err.httpStatus >= 500) req.log.warn({ code: err.code }, err.message);
      return reply.code(err.httpStatus).send(errorBody(err.code, err.message, err.details));
    }
    const mapped = fromFastifyError(err);
    if (mapped) return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
    if (isConnectionError(err)) {
      req.log.error({ err }, 'dependency unavailable');
      return reply.code(503).send(errorBody('DEPENDENCY_UNAVAILABLE', 'A dependency is temporarily unavailable'));
    }
    // Unexpected: log everything, return nothing internal. The correlation id header links the two.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Unexpected error'));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody('ROUTE_NOT_FOUND', `Route ${req.method} ${req.url.split('?')[0]} not found`));
  });

  app.get('/health', async (_req, reply) => {
    const dependencies = await deps.health();
    const healthy = Object.values(dependencies).every((v) => v === 'ok');
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', deps: dependencies });
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  const openApiPath = deps.openApiPath ?? path.resolve(process.cwd(), 'docs/openapi.yaml');
  app.get('/openapi.yaml', async (_req, reply) => {
    const spec = await readFile(openApiPath, 'utf8').catch(() => undefined);
    if (!spec) throw new AppError('ROUTE_NOT_FOUND', 404, 'OpenAPI document not available');
    // text/plain so a browser shows the contract instead of downloading it; tools read it the same way.
    return reply.type('text/plain; charset=utf-8').send(spec);
  });

  // Interactive docs at /docs, rendered from the same contract file: no per-route annotations to keep in sync.
  if (existsSync(openApiPath)) {
    await app.register(swagger, {
      mode: 'static',
      specification: { path: openApiPath, baseDir: path.dirname(openApiPath) },
    });
    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });
  } else {
    deps.logger.warn({ openApiPath }, 'OpenAPI document not found, /docs is disabled');
  }

  await app.register(catalogRoutes, { service: deps.catalog });
  await app.register(checkoutRoutes, { service: deps.checkout });
  await app.register(ordersRoutes, { service: deps.orders });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
