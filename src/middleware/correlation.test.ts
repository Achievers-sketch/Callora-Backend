import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { correlationMiddleware, sanitizeCorrelationId, CORRELATION_ID_MAX_LENGTH } from './correlation.js';
import { getCorrelationId, runWithRequestContext } from '../utils/asyncContext.js';

describe('sanitizeCorrelationId', () => {
  test('returns the value unchanged for a normal id', () => {
    assert.equal(sanitizeCorrelationId('corr-abc-123'), 'corr-abc-123');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(sanitizeCorrelationId('  test-corr-id  '), 'test-corr-id');
  });

  test('strips CR and LF to prevent header injection', () => {
    assert.equal(sanitizeCorrelationId('id\r\nX-Evil: injected'), 'idX-Evil: injected');
  });

  test('strips all ASCII control characters', () => {
    assert.equal(sanitizeCorrelationId('id\x00\x01\x1F\x7F'), 'id');
  });

  test('returns undefined for empty string', () => {
    assert.equal(sanitizeCorrelationId(''), undefined);
  });

  test('returns undefined for whitespace-only string', () => {
    assert.equal(sanitizeCorrelationId('   '), undefined);
  });

  test('returns undefined for undefined input', () => {
    assert.equal(sanitizeCorrelationId(undefined), undefined);
  });

  test('returns undefined when value exceeds CORRELATION_ID_MAX_LENGTH', () => {
    const oversized = 'a'.repeat(CORRELATION_ID_MAX_LENGTH + 1);
    assert.equal(sanitizeCorrelationId(oversized), undefined);
  });

  test('accepts value exactly at CORRELATION_ID_MAX_LENGTH', () => {
    const maxLen = 'a'.repeat(CORRELATION_ID_MAX_LENGTH);
    assert.equal(sanitizeCorrelationId(maxLen), maxLen);
  });
});

describe('correlationMiddleware', () => {
  test('uses incoming x-correlation-id header and sets response header', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-correlation-id' ? 'test-corr-123' : undefined),
    } as unknown as Request;

    const res = {
      setHeader: (name: string, value: string) => {
        assert.equal(name, 'X-Correlation-Id');
        assert.equal(value, 'test-corr-123');
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal((req as unknown as { correlationId?: string }).correlationId, 'test-corr-123');
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('generates a UUID when header is absent', (done) => {
    const req = {
      header: () => undefined,
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => {
        setHeaderValue = value;
      },
    } as unknown as Response;

    const next = (() => {
      assert.ok((req as unknown as { correlationId?: string }).correlationId, 'req.correlationId must be set');
      assert.ok(setHeaderValue, 'response X-Correlation-Id must be set');
      assert.equal((req as unknown as { correlationId?: string }).correlationId, setHeaderValue);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      assert.match((req as unknown as { correlationId?: string }).correlationId ?? '', uuidRegex);

      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('strips whitespace from x-correlation-id header', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-correlation-id' ? '  trimmed-corr  ' : undefined),
    } as unknown as Request;

    const res = {
      setHeader: (_name: string, value: string) => {
        assert.equal(value, 'trimmed-corr');
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal((req as unknown as { correlationId?: string }).correlationId, 'trimmed-corr');
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('generates a UUID when header contains only control characters', (done) => {
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-correlation-id' ? '\r\n\x00' : undefined),
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('generates a UUID when header value exceeds max length', (done) => {
    const oversized = 'x'.repeat(CORRELATION_ID_MAX_LENGTH + 1);
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-correlation-id' ? oversized : undefined),
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      assert.notEqual(setHeaderValue, oversized);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('stores correlationId in async context for downstream consumption', (done) => {
    runWithRequestContext({ requestId: 'parent-req-id' }, () => {
      const req = {
        header: (name: string) => (name.toLowerCase() === 'x-correlation-id' ? 'async-corr-123' : undefined),
      } as unknown as Request;

      const res = {
        setHeader: () => {},
      } as unknown as Response;

      const next = (() => {
        assert.equal(getCorrelationId(), 'async-corr-123');
        done();
      }) as NextFunction;

      correlationMiddleware(req, res, next);
    });
  });

  test('strips CRLF injection attempt and uses sanitized value', (done) => {
    const req = {
      header: (name: string) =>
        name.toLowerCase() === 'x-correlation-id' ? 'safe-corr\r\nX-Evil: injected' : undefined,
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      assert.equal(setHeaderValue, 'safe-corrX-Evil: injected');
      assert.ok(!setHeaderValue?.includes('\r'));
      assert.ok(!setHeaderValue?.includes('\n'));
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });
});
