/**
 * Correlation ID middleware: read an incoming header or generate a UUID,
 * attach it to a per-request context, and echo it back on the response.
 *
 * Design decisions (stated plainly so the tests and README stay honest):
 *
 * 1. UUID generation uses crypto.randomUUID(). It is available in Node 14.17+
 * and all evergreen browsers. We do not ship a polyfill; if the runtime lacks
 * it, the middleware throws synchronously on the first request without a
 * header. That is the one sharp edge, and it is deliberate: a polyfill would
 * be a third-party dependency in spirit, and the brief forbids those.
 *
 * 2. The per-request context is an AsyncLocalStorage. This is the standard,
 * zero-dependency way to carry request-scoped state through async jumps
 * without threading an explicit argument. It lives in node:async_hooks.
 *
 * 3. The header name is configurable but defaults to 'x-correlation-id'.
 * Incoming values are trimmed; empty-after-trim is treated as absent so that
 * a stray ' ' header does not become a correlation id of spaces.
 *
 * 4. The middleware is framework-agnostic: it takes a plain request object
 * with a `headers` map and a response object with a `setHeader` function,
 * plus a `next()` callback. This keeps the library free of any framework
 * dependency while still being usable from Express, Fastify, or a raw
 * http.Server handler with a one-line adapter.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The AsyncLocalStorage that holds the current correlation id.
 *
 * Exposed so that code deep in the call stack can read the id without an
 * explicit parameter. Use `getCorrelationId()` rather than touching this
 * directly — it returns undefined when no request is in flight, which is
 * the only sane default for logging paths that run outside a request.
 */
export const correlationIdContext = new AsyncLocalStorage();

/**
 * Default header name for the correlation id. Lowercase, as Node's HTTP
 * message parsers lowercase incoming header names.
 */
export const DEFAULT_HEADER = 'x-correlation-id';

/**
 * Returns the correlation id for the current async context, or undefined if
 * none is set (e.g. called outside a request, or before the middleware has
 * run). Callers that need a string should coalesce to a fallback themselves;
 * this function does not guess.
 *
 * @returns {string | undefined}
 */
export function getCorrelationId() {
  return correlationIdContext.getStore();
}

/**
 * Runs `fn` with `id` installed as the current correlation id. This is the
 * low-level primitive the middleware uses; it is also exported so that
 * callers can seed a context in tests or in non-HTTP entry points (a queue
 * worker, a cron job) and have `getCorrelationId()` behave the same as it
 * does inside an HTTP request.
 *
 * @param {string} id - The correlation id to install.
 * @param {() => any} fn - The function to run inside the context.
 * @returns {any} Whatever `fn` returns.
 */
export function runWithCorrelationId(id, fn) {
  return correlationIdContext.run(id, fn);
}

/**
 * Generates a fresh UUID v4. Thin wrapper around crypto.randomUUID so that
 * tests can observe generation without monkey-patching the crypto module —
 * the middleware factory accepts a `generateId` option for that purpose.
 *
 * @returns {string}
 */
function defaultGenerateId() {
  return randomUUID();
}

/**
 * Extracts a correlation id from an incoming request's headers.
 *
 * Returns undefined when the header is absent or empty after trimming.
 * We do not validate the shape of an incoming id: the point of a correlation
 * id is to trace a hop that already happened, so an upstream service's
 * (possibly non-UUID) id is more useful than a fresh one we minted. If a
 * caller wants strict validation, they can wrap this middleware.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} headerName
 * @returns {string | undefined}
 */
function readIncomingId(headers, headerName) {
  const raw = headers ? headers[headerName] : undefined;
  if (raw === undefined || raw === null) return undefined;
  // Node collapses repeated headers into an array joined by ', '. We take
  // the first segment before any comma, which is the first sent value.
  const first = Array.isArray(raw) ? raw[0] : String(raw).split(',', 1)[0];
  const trimmed = (first ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Creates a correlation-id middleware.
 *
 * @param {object} [options]
 * @param {string} [options.header=DEFAULT_HEADER] - Header name to read
 *   from the request and set on the response. Lowercase.
 * @param {() => string} [options.generateId] - Function called when no
 *   incoming id is found. Defaults to crypto.randomUUID. Override in tests
 *   for determinism.
 * @returns {(req: { headers: Record<string, string | string[] | undefined> },
 *           res: { setHeader: (name: string, value: string) => void },
 *           next: () => void) => void}
 */
export function correlationIdMiddleware(options = {}) {
  const header = options.header ?? DEFAULT_HEADER;
  const generateId = options.generateId ?? defaultGenerateId;

  if (typeof header !== 'string' || header.length === 0) {
    throw new TypeError('options.header must be a non-empty string');
  }
  if (typeof generateId !== 'function') {
    throw new TypeError('options.generateId must be a function');
  }

  return function correlationIdMiddlewareImpl(req, res, next) {
    if (req === null || typeof req !== 'object') {
      throw new TypeError('middleware requires a request object');
    }
    if (res === null || typeof res !== 'object' || typeof res.setHeader !== 'function') {
      throw new TypeError('middleware requires a response object with setHeader');
    }
    if (typeof next !== 'function') {
      throw new TypeError('middleware requires a next callback');
    }

    const incoming = readIncomingId(req.headers, header);
    const id = incoming ?? generateId();

    // Set the response header before running downstream handlers so that even
    // if `next` throws, the response (if it goes out at all) carries the id.
    res.setHeader(header, id);

    correlationIdContext.run(id, () => {
      // `next` is invoked inside the run callback so that any async work it
      // starts — which is the common case for route handlers — inherits the
      // context. This is the whole reason we use AsyncLocalStorage rather
      // than a closure variable.
      next();
    });
  };
}
