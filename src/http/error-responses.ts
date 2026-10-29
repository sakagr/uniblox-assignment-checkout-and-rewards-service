import { Type } from '@fastify/type-provider-typebox';
import type { ErrorCode } from '../domain/errors.js';

type ErrorStatus = 400 | 404 | 409 | 422 | 503;

/**
 * `details` must stay Type.Unknown(): any narrower schema makes fast-json-stringify
 * drop or mangle its content (arrays for INSUFFICIENT_STOCK, objects for QUOTE_STALE).
 * `code` stays a plain string so serialization never depends on matching a union branch.
 */
function errorEnvelope(codes: readonly ErrorCode[]) {
  return Type.Object(
    {
      error: Type.Object({
        code: Type.String(),
        message: Type.String(),
        details: Type.Unknown(),
      }),
    },
    { description: codes.join(', ') },
  );
}

/**
 * Error responses for a route's `schema.response`, keyed by status. The codes
 * become the response description in OpenAPI. 500 is always added.
 */
export function errorResponses(codesByStatus: Partial<Record<ErrorStatus, readonly ErrorCode[]>>) {
  const responses: Record<number, ReturnType<typeof errorEnvelope>> = {};
  for (const [status, codes] of Object.entries(codesByStatus)) {
    responses[Number(status)] = errorEnvelope(codes);
  }
  responses[500] = errorEnvelope(['INTERNAL_ERROR']);
  return responses;
}
