import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  correlationIdMiddleware,
  getCorrelationId,
  runWithCorrelationId,
  correlationIdContext,
  DEFAULT_HEADER,
} from '../src/core.js';

/**
 * Minimal request/response doubles. The middleware is framework-agnostic:
 * it only needs `req.headers` and `res.setHeader`. Using plain objects keeps
 * the tests free of any framework dependency and makes assertions trivial.
 */
function makeReq(headers = {}) {
  return { headers };
}

function makeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

/**
 * A fixed id generator so tests never depend on crypto.randomUUID's output.
 */
const FIXED_ID = '11111111-1111-4111-8111-111111111111';
const fixedId = () => FIXED_ID;

test('generates an id when no incoming header is present', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({});
  const res = makeRes();
  let captured;

  mw(req, res, () => {
    captured = getCorrelationId();
  });

  assert.equal(captured, FIXED_ID);
  assert.equal(res.headers[DEFAULT_HEADER], FIXED_ID);
});

test('uses the incoming header when present', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const incoming = 'upstream-trace-abc';
  const req = makeReq({ [DEFAULT_HEADER]: incoming });
  const res = makeRes();
  let captured;

  mw(req, res, () => {
    captured = getCorrelationId();
  });

  assert.equal(captured, incoming);
  assert.equal(res.headers[DEFAULT_HEADER], incoming);
});

test('does not call generateId when an incoming id is present', () => {
  let generateCalled = false;
  const mw = correlationIdMiddleware({
    generateId: () => {
      generateCalled = true;
      return 'should-not-be-used';
    },
  });
  const req = makeReq({ [DEFAULT_HEADER]: 'incoming-id' });
  const res = makeRes();

  mw(req, res, () => {});

  assert.equal(generateCalled, false);
  assert.equal(res.headers[DEFAULT_HEADER], 'incoming-id');
});

test('treats a whitespace-only header as absent', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({ [DEFAULT_HEADER]: '   ' });
  const res = makeRes();
  let captured;

  mw(req, res, () => {
    captured = getCorrelationId();
  });

  assert.equal(captured, FIXED_ID);
  assert.equal(res.headers[DEFAULT_HEADER], FIXED_ID);
});

test('trims a header value that has surrounding whitespace', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({ [DEFAULT_HEADER]: '  abc-123  ' });
  const res = makeRes();
  let captured;

  mw(req, res, () => {
    captured = getCorrelationId();
  });

  assert.equal(captured, 'abc-123');
  assert.equal(res.headers[DEFAULT_HEADER], 'abc-123');
});

test('takes the first value when the header is an array', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({ [DEFAULT_HEADER]: ['first-id', 'second-id'] });
  const res = makeRes();
  let captured;

  mw(req, res, () => {
    captured = getCorrelationId();
  });

  assert.equal(captured, 'first-id');
  assert.equal(res.headers[DEFAULT_HEADER], 'first-id');
});

test('takes the first segment when the header is a comma-joined string', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({ [DEFAULT_HEADER]: 'first-id, second-id' });
  const res = makeRes();
  let captured;

  mw(req, res, () => {
    captured = getCorrelationId();
  });

  assert.equal(captured, 'first-id');
});

test('honours a custom header name for both read and write', () => {
  const custom = 'x-request-id';
  const mw = correlationIdMiddleware({ header: custom, generateId: fixedId });
  const req = makeReq({ [custom]: 'custom-incoming' });
  const res = makeRes();
  let captured;

  mw(req, res, () => {
    captured = getCorrelationId();
  });

  assert.equal(captured, 'custom-incoming');
  assert.equal(res.headers[custom], 'custom-incoming');
  // The default header must not be written when a custom name is in use.
  assert.equal(res.headers[DEFAULT_HEADER], undefined);
});

test('getCorrelationId returns undefined outside a request', () => {
  assert.equal(getCorrelationId(), undefined);
});

test('getCorrelationId returns undefined outside a request even after a request has run', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({});
  const res = makeRes();

  mw(req, res, () => {
    assert.equal(getCorrelationId(), FIXED_ID);
  });

  // After the request's async context exits, the id must no longer leak.
  assert.equal(getCorrelationId(), undefined);
});

test('the correlation id is visible inside an async hop started by next', async () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({});
  const res = makeRes();

  // Resolve on the next tick of the microtask queue, which is enough to
  // leave the synchronous call stack of `mw`. AsyncLocalStorage propagates
  // through this; a closure variable would not.
  const seen = new Promise((resolve) => {
    mw(req, res, () => {
      queueMicrotask(() => {
        resolve(getCorrelationId());
      });
    });
  });

  assert.equal(await seen, FIXED_ID);
});

test('runWithCorrelationId installs an id and returns the function result', () => {
  const result = runWithCorrelationId('manual-id', () => {
    return getCorrelationId();
  });

  assert.equal(result, 'manual-id');
});

test('runWithCorrelationId does not leak its id to the outer context', () => {
  assert.equal(getCorrelationId(), undefined);

  runWithCorrelationId('inner-id', () => {
    assert.equal(getCorrelationId(), 'inner-id');
  });

  assert.equal(getCorrelationId(), undefined);
});

test('the response header is set before next is called', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  const req = makeReq({});
  const res = makeRes();

  mw(req, res, () => {
    // If the header were set after next, this would be undefined.
    assert.equal(res.headers[DEFAULT_HEADER], FIXED_ID);
  });
});

test('throws on a non-string header option', () => {
  assert.throws(
    () => correlationIdMiddleware({ header: 123 }),
    { name: 'TypeError' }
  );
});

test('throws on an empty header option', () => {
  assert.throws(
    () => correlationIdMiddleware({ header: '' }),
    { name: 'TypeError' }
  );
});

test('throws on a non-function generateId option', () => {
  assert.throws(
    () => correlationIdMiddleware({ generateId: 'not-a-function' }),
    { name: 'TypeError' }
  );
});

test('throws when req is not an object', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  assert.throws(
    () => mw(null, makeRes(), () => {}),
    { name: 'TypeError' }
  );
});

test('throws when res lacks setHeader', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  assert.throws(
    () => mw(makeReq({}), {}, () => {}),
    { name: 'TypeError' }
  );
});

test('throws when next is not a function', () => {
  const mw = correlationIdMiddleware({ generateId: fixedId });
  assert.throws(
    () => mw(makeReq({}), makeRes(), null),
    { name: 'TypeError' }
  );
});

test('correlationIdContext is the AsyncLocalStorage instance', () => {
  // This is a light sanity check that the exported object is the same one
  // the middleware uses, so consumers who want to call .enterWith or inspect
  // the store are not surprised.
  assert.equal(typeof correlationIdContext.run, 'function');
  assert.equal(typeof correlationIdContext.getStore, 'function');
});
