import { RlsInterceptor } from './rls.interceptor';
import { PrismaService } from './prisma.service';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';

describe('RlsInterceptor', () => {
  let interceptor: RlsInterceptor;
  let prisma: jest.Mocked<Partial<PrismaService>>;
  let config: jest.Mocked<Partial<ConfigService>>;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
    };
    config = {
      get: jest.fn(),
    };
    interceptor = new RlsInterceptor(prisma as any, config as any);
  });

  function createMockContext(request: any): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  function createMockCallHandler(result: any = 'ok'): CallHandler {
    return {
      handle: () => of(result),
    };
  }

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  it('should skip RLS wrapping when no accountId', (done) => {
    const ctx = createMockContext({ url: '/v1/memories' });
    const handler = createMockCallHandler('result');

    interceptor.intercept(ctx, handler).subscribe({
      next: (val) => {
        expect(val).toBe('result');
        expect(prisma.$transaction).not.toHaveBeenCalled();
        done();
      },
      error: done,
    });
  });

  it('should enforce RLS wrapping for sync push endpoint', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn) => {
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: 'acc-123',
      url: '/v1/sync/push',
    });
    const handler = createMockCallHandler('sync-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: (val) => {
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
          "SET LOCAL app.current_account_id = 'acc-123'",
        );
        done();
      },
      error: done,
    });
  });

  it('should wrap in transaction with SET LOCAL when accountId present', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn) => {
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: 'acc-123',
      url: '/v1/memories',
    });
    const handler = createMockCallHandler('wrapped');

    interceptor.intercept(ctx, handler).subscribe({
      next: (val) => {
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
          "SET LOCAL app.current_account_id = 'acc-123'",
        );
        done();
      },
      error: done,
    });
  });

  it('should sanitize accountId to prevent injection', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn) => {
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: "acc-123'; DROP TABLE memories; --",
      url: '/v1/memories',
    });
    const handler = createMockCallHandler('safe');

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {
        expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
          "SET LOCAL app.current_account_id = 'acc-123DROPTABLEmemories--'",
        );
        done();
      },
      error: done,
    });
  });

  it('should use long timeout for dedup/scan endpoint', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn, opts) => {
      expect(opts.timeout).toBe(300_000); // 5 min for dedup scan
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: 'acc-123',
      url: '/v1/dedup/scan',
    });
    const handler = createMockCallHandler('dedup-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: () => done(),
      error: done,
    });
  });

  it('should use default 30s timeout for non-long-running endpoints', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn, opts) => {
      expect(opts.timeout).toBe(30_000); // 30s default
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: 'acc-123',
      url: '/v1/memories',
    });
    const handler = createMockCallHandler('default-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: () => done(),
      error: done,
    });
  });

  it('should use long timeout for sync endpoints', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn, opts) => {
      expect(opts.timeout).toBe(300_000); // 5 min for sync
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: 'acc-123',
      url: '/v1/sync/push',
    });
    const handler = createMockCallHandler('sync-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: () => done(),
      error: done,
    });
  });

  it('should enforce RLS for sync pull endpoint', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn) => {
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: 'acc-789',
      url: '/v1/sync/pull?since=2024-01-01',
    });
    const handler = createMockCallHandler('pull-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
          "SET LOCAL app.current_account_id = 'acc-789'",
        );
        done();
      },
      error: done,
    });
  });

  it('should resolve accountId from agent when no direct accountId', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn) => {
      return fn(mockTx);
    });

    const ctx = createMockContext({
      agent: { accountId: 'agent-acc-456' },
      url: '/v1/memories',
    });
    const handler = createMockCallHandler('agent-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {
        expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
          "SET LOCAL app.current_account_id = 'agent-acc-456'",
        );
        done();
      },
      error: done,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RLS role enforcement tests (SET LOCAL ROLE app)
  // ──────────────────────────────────────────────────────────────────────────

  it('should call SET LOCAL ROLE app when accountId is present', (done) => {
    const mockTx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    prisma.$transaction = jest.fn().mockImplementation(async (fn) => {
      return fn(mockTx);
    });

    const ctx = createMockContext({
      accountId: 'acc-rls-test',
      url: '/v1/memories',
    });
    const handler = createMockCallHandler('rls-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {
        expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith(
          "SET LOCAL app.current_account_id = 'acc-rls-test'",
        );
        expect(mockTx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE app');
        // Ensure account_id is set BEFORE role switch
        const calls = mockTx.$executeRawUnsafe.mock.calls.map((c: string[]) => c[0]);
        const accountIdIdx = calls.findIndex((c: string) =>
          c.includes('current_account_id'),
        );
        const roleIdx = calls.findIndex((c: string) => c === 'SET LOCAL ROLE app');
        expect(accountIdIdx).toBeLessThan(roleIdx);
        done();
      },
      error: done,
    });
  });

  it('should NOT call SET LOCAL ROLE app when accountId is null', (done) => {
    // No accountId → intercept returns next.handle() directly, no transaction
    const ctx = createMockContext({ url: '/v1/memories' });
    const handler = createMockCallHandler('passthrough');

    interceptor.intercept(ctx, handler).subscribe({
      next: (val) => {
        expect(val).toBe('passthrough');
        expect(prisma.$transaction).not.toHaveBeenCalled();
        done();
      },
      error: done,
    });
  });

  it('should NOT call SET LOCAL ROLE app for /consolidation/ skip path', (done) => {
    const ctx = createMockContext({
      accountId: 'acc-admin',
      url: '/v1/consolidation/trigger',
    });
    const handler = createMockCallHandler('skip-result');

    interceptor.intercept(ctx, handler).subscribe({
      next: (val) => {
        expect(val).toBe('skip-result');
        expect(prisma.$transaction).not.toHaveBeenCalled();
        done();
      },
      error: done,
    });
  });

  it('should NOT call SET LOCAL ROLE app for /consolidate skip path', (done) => {
    const ctx = createMockContext({
      accountId: 'acc-admin',
      url: '/v1/consolidate',
    });
    const handler = createMockCallHandler('skip-consolidate');

    interceptor.intercept(ctx, handler).subscribe({
      next: (val) => {
        expect(val).toBe('skip-consolidate');
        expect(prisma.$transaction).not.toHaveBeenCalled();
        done();
      },
      error: done,
    });
  });

  it('should NOT call SET LOCAL ROLE app for /dedup/batch skip path', (done) => {
    const ctx = createMockContext({
      accountId: 'acc-admin',
      url: '/v1/dedup/batch',
    });
    const handler = createMockCallHandler('skip-dedup-batch');

    interceptor.intercept(ctx, handler).subscribe({
      next: (val) => {
        expect(val).toBe('skip-dedup-batch');
        expect(prisma.$transaction).not.toHaveBeenCalled();
        done();
      },
      error: done,
    });
  });
});
