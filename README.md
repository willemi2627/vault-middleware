# Correlation ID Middleware

Reads an incoming correlation id header (or generates a UUID v4 when none is
present), attaches it to a per-request async context, and echoes it back on the
response.

## Usage

```js
import {
  correlationIdMiddleware,
  getCorrelationId,
} from 'correlation-id-middleware';

const mw = correlationIdMiddleware({
  header: 'x-correlation-id', // default
  generateId: () => crypto.randomUUID(), // default
});

const req = { headers: { 'x-correlation-id': 'upstream-trace-abc' } };
const res = { setHeader: (name, value) => { res.headers = res.headers || {}; res.headers[name] = value; } };

mw(req, res, () => {
  // The id is now visible anywhere in the async call tree:
  console.log(getCorrelationId());
});
```

The middleware is framework-agnostic. It expects a `req` with a `headers`
map, a `res` with a `setHeader(name, value)` method, and a `next` callback.

## Exports

- `correlationIdMiddleware(options?)` — returns `(req, res, next) => void`.
  Options: `header` (string, default `'x-correlation-id'`), `generateId`
  (function, default `crypto.randomUUID`).
- `getCorrelationId()` — returns the current id, or `undefined` outside a
  request.
- `runWithCorrelationId(id, fn)` — runs `fn` with `id` installed; returns
  whatever `fn` returns.
- `correlationIdContext` — the underlying `AsyncLocalStorage`.
- `DEFAULT_HEADER` — the string `'x-correlation-id'`.

## Why this exists

Distributed systems need a single id to follow a request across hops. Doing
this with a closure variable means threading it through every function
signature; doing it with a module-level variable leaks one request's id into
another under concurrency. `AsyncLocalStorage` solves both, and is in the
standard library, so the middleware has no third-party dependencies.

The trade-off: `AsyncLocalStorage` has a small per-call cost. For a service
that does not log or emit traces, that overhead is wasted. This library is for
services that do.

## Edge cases worth knowing

- **No incoming header validation.** An upstream service's id is used as-is,
  even if it is not a UUID. A correlation id's job is to trace a hop that
  already happened; replacing a non-UUID upstream id with a fresh one breaks
  that trace. If you need strict validation, wrap the middleware.
- **Whitespace-only headers are treated as absent.** A header of `'   '` does
  not become a correlation id of spaces; the middleware generates a fresh one.
- **Array headers take the first value.** Node collapses repeated headers into
  an array; the middleware uses the first element.
- **`crypto.randomUUID` is required.** If the runtime lacks it and no incoming
  header is present, the middleware throws on the first request. There is no
  polyfill, by design — a polyfill would be a third-party dependency in spirit.
- **The response header is set before `next` runs.** If `next` throws and the
  response still goes out, it carries the correlation id.
