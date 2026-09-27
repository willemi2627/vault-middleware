/**
 * Public entry point for the correlation-id middleware library.
 *
 * Re-exports the pieces a consumer needs: the core middleware factory,
 * the AsyncLocalStorage-backed context, and the helpers for reading the
 * current correlation id outside of request handling.
 */

export { correlationIdMiddleware } from './core.js';
export { getCorrelationId, runWithCorrelationId, correlationIdContext } from './core.js';
