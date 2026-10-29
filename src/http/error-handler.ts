import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, Errors } from '../domain/errors.js';

/** Postgres errors that are safe to retry: deadlock, serialization failure, lock timeout. */
const TRANSIENT_SQLSTATES = new Set(['40P01', '40001', '55P03']);
const COUPON_CODE_UNIQUE = 'coupons_code_key';

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function isTransientPgError(error: unknown): boolean {
  const { code, constraint } = error as PgErrorLike;
  if (code === undefined) return false;
  if (TRANSIENT_SQLSTATES.has(code)) return true;
  // A coupon-code collision: astronomically unlikely, safe to retry (§6.6).
  return code === '23505' && constraint === COUPON_CODE_UNIQUE;
}

function send(reply: FastifyReply, error: DomainError, statusCode = error.statusCode) {
  return reply
    .status(statusCode)
    .send({ error: { code: error.code, message: error.message, details: error.details } });
}

interface AjvIssue {
  instancePath: string;
  message?: string;
  params?: { missingProperty?: string; additionalProperty?: string };
}

function validationDetails(error: FastifyError) {
  const location = error.validationContext ?? 'body';
  return (error.validation as AjvIssue[]).map((issue) => {
    const property = issue.params?.missingProperty ?? issue.params?.additionalProperty;
    return {
      location,
      path: property ? `${issue.instancePath}/${property}` : issue.instancePath,
      message: issue.message ?? 'invalid',
    };
  });
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    send(reply, Errors.routeNotFound(request.method, request.url)),
  );

  app.setErrorHandler((error: FastifyError | DomainError, request, reply) => {
    if (error instanceof DomainError) return send(reply, error);

    if ('validation' in error && error.validation) {
      return send(reply, Errors.validation(validationDetails(error)));
    }

    if (isTransientPgError(error)) {
      request.log.warn({ err: error }, 'transient database conflict');
      return send(reply, Errors.transientConflict());
    }

    // Fastify's own 4xx (malformed JSON, 413, 415, ...): client errors.
    const status = (error as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500 && error.code?.startsWith('FST_')) {
      return send(reply, Errors.validation({ reason: error.code }, error.message), status);
    }

    request.log.error({ err: error }, 'unhandled error');
    return send(reply, Errors.internal({ requestId: request.id }));
  });
}
