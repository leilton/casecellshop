import type { z } from 'zod';
import { AppError } from '../shared/errors';

export interface FieldIssue {
  path: string;
  message: string;
}

export function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'Request is invalid', toFieldIssues(parsed.error));
  }
  return parsed.data;
}
