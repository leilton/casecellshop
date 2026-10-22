import {
  type Attributes,
  type Context,
  context,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

const tracer = trace.getTracer('casecellshop');

/** Wraps a business step in a span; records the exception and rethrows so callers keep their error handling. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Serialises the active trace context (traceparent) so it can travel inside an outbox row / SQS message. */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function extractTraceContext(carrier: Record<string, string> | undefined): Context {
  return propagation.extract(context.active(), carrier ?? {});
}

export function runInContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}
