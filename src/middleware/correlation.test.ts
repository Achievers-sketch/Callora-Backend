import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import {
  correlationMiddleware,
  sanitizeCorrelationId,
  buildOutboundCorrelationHeaders,
  CORRELATION_ID_MAX_LENGTH,
} from './correlation.js';

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
  test('uses incoming x-correlation-id header', (done) => {
    const req = {
      header: (name: string) =>
        name.toLowerCase() === 'x-correlation-id' ? 'test-corr-id' : undefined,
      id: 'req-id-123',
    } as unknown as Request;

    const res = {
      setHeader: (name: string, value: string) => {
        assert.equal(name, 'X-Correlation-Id');
        assert.equal(value, 'test-corr-id');
      },
    } as unknown as Response;

    const next = (() => {
      assert.equal((req as unknown as { correlationId?: string }).correlationId, 'test-corr-id');
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('falls back to req.id when x-correlation-id is absent', (done) => {
    const req = {
      header: () => undefined,
      id: 'req-id-123',
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      assert.equal(setHeaderValue, 'req-id-123');
      assert.equal((req as unknown as { correlationId?: string }).correlationId, 'req-id-123');
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('generates a UUID when neither header nor req.id is available', (done) => {
    const req = {
      header: () => undefined,
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      assert.ok(setHeaderValue, 'X-Correlation-Id must be set');
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(setHeaderValue ?? '', uuidRegex);
      assert.equal((req as unknown as { correlationId?: string }).correlationId, setHeaderValue);
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('prefers x-correlation-id over req.id', (done) => {
    const req = {
      header: (name: string) =>
        name.toLowerCase() === 'x-correlation-id' ? 'explicit-corr-id' : undefined,
      id: 'req-id-123',
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      assert.equal(setHeaderValue, 'explicit-corr-id');
      assert.equal((req as unknown as { correlationId?: string }).correlationId, 'explicit-corr-id');
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });

  test('strips CRLF injection attempt from x-correlation-id', (done) => {
    const req = {
      header: (name: string) =>
        name.toLowerCase() === 'x-correlation-id' ? 'safe-id\r\nX-Evil: injected' : undefined,
      id: 'req-id-123',
    } as unknown as Request;

    let setHeaderValue: string | undefined;
    const res = {
      setHeader: (_name: string, value: string) => { setHeaderValue = value; },
    } as unknown as Response;

    const next = (() => {
      assert.equal(setHeaderValue, 'safe-idX-Evil: injected');
      assert.ok(!setHeaderValue?.includes('\r'));
      assert.ok(!setHeaderValue?.includes('\n'));
      done();
    }) as NextFunction;

    correlationMiddleware(req, res, next);
  });
});

describe('buildOutboundCorrelationHeaders', () => {
  test('returns headers with X-Correlation-Id from async context', () => {
    const headers = buildOutboundCorrelationHeaders();
    assert.ok(headers['X-Correlation-Id']);
    assert.equal(typeof headers['X-Correlation-Id'], 'string');
  });
});
