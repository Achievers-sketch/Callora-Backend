import { writeQuery } from '../db.js';

jest.mock('../db.js', () => ({ writeQuery: jest.fn() }));
const writeQueryMock = writeQuery as jest.MockedFunction<typeof writeQuery>;

import { defaultAuditService } from './auditService.js';

describe('auditService.record', () => {
  beforeEach(() => {
    writeQueryMock.mockReset();
    writeQueryMock.mockResolvedValue({ rows: [] });
  });

  it('inserts one row into audit_logs with a generated id and all fields', async () => {
    await defaultAuditService.record({
      event: 'API_CREATE',
      actor: 'dev-1',
      tenantId: 'dev-1',
      clientIp: '1.2.3.4',
      userAgent: 'jest-UA',
      correlationId: 'req-1',
      bodyHash: 'deadbeef',
      details: { before: null, after: { name: 'X' } },
    });

    expect(writeQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = writeQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params).toHaveLength(9);
    expect(typeof params[0]).toBe('string');
    expect(params.slice(1)).toEqual([
      'API_CREATE',
      'dev-1',
      'dev-1',
      '1.2.3.4',
      'jest-UA',
      'req-1',
      'deadbeef',
      JSON.stringify({ before: null, after: { name: 'X' } }),
    ]);
  });

  it('nulls optional forensic fields and details when omitted', async () => {
    await defaultAuditService.record({ event: 'E', actor: 'a' });
    const [, params] = writeQueryMock.mock.calls[0] as [string, unknown[]];
    expect(params.slice(3)).toEqual([null, null, null, null, null, null]);
  });
});
