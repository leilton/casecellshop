import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

type Json = Record<string, unknown>;

const spec = parse(readFileSync(path.resolve(__dirname, '../../docs/openapi.yaml'), 'utf8')) as Json;
// OpenAPI keywords such as `example` are not JSON Schema; strict mode would reject them.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'openapi');

function resolve(node: unknown): Json {
  let current = node as Json;
  while (typeof current?.$ref === 'string') {
    const pointer = (current.$ref as string).replace(/^#\//, '').split('/');
    current = pointer.reduce<unknown>(
      (acc, key) => (acc as Json)[key.replace(/~1/g, '/').replace(/~0/g, '~')],
      spec,
    ) as Json;
  }
  return current;
}

const escapePointer = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Validates a real response against the documented one: the status must be documented for the operation and
 * the JSON body must match its schema. Returns the Ajv errors (empty when valid).
 */
export function contractErrors(method: string, specPath: string, status: number, body: unknown): string[] {
  const operation = resolve(((spec.paths as Json)[specPath] as Json | undefined)?.[method.toLowerCase()]);
  if (!operation) return [`${method} ${specPath} is not documented`];
  const responses = operation.responses as Json;
  const response = responses[String(status)];
  if (!response) return [`status ${status} is not documented for ${method} ${specPath}`];
  const media = (resolve(response).content as Json | undefined)?.['application/json'] as Json | undefined;
  if (!media) return [];

  // Point Ajv at the schema inside the registered spec so internal $refs resolve.
  const responseRef = (response as Json).$ref as string | undefined;
  const ref = responseRef
    ? `openapi${responseRef}/content/application~1json/schema`
    : `openapi#/paths/${escapePointer(specPath)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const validate = ajv.compile({ $ref: ref });
  if (validate(body)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`);
}
