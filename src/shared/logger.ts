import pino from 'pino';
import { currentContext } from './context';

export type Logger = pino.Logger;

/**
 * Every log line carries correlationId/orderId from the async context, so handlers never have to
 * thread them through by hand. OTel's pino instrumentation adds trace_id/span_id on top.
 */
export function createLogger(service: string, level = 'info', destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
      mixin() {
        const ctx = currentContext();
        if (!ctx) return {};
        return {
          correlationId: ctx.correlationId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          ...(ctx.orderId ? { orderId: ctx.orderId } : {}),
        };
      },
    },
    destination,
  );
}
