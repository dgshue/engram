import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  EntitySemanticService,
  SemanticMatch,
} from './entity-semantic.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Global mocks ─────────────────────────────────────────────────────────────

const mockPrisma = {
  memory: {
    findFirst: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: string) => {
    const map: Record<string, string> = {
      LOCAL_EMBED_URL: 'http://localhost:8080',
    };
    return map[key] ?? defaultValue;
  }),
};

// Helper: build a fake embedding vector of dimension N
const makeVector = (n: number, value = 1): number[] =>
  Array.from({ length: n }, (_, i) => value * (i + 1));

// Helper: format as postgres vector text
const pgVector = (vec: number[]): string => `[${vec.join(',')}]`;

// ─── fetch mock ───────────────────────────────────────────────────────────────

const mockFetchResponse = (body: unknown, ok = true, status = 200) => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    json: jest.fn().mockResolvedValue(body),
  });
};

describe('EntitySemanticService', () => {
  let service: EntitySemanticService;

  beforeAll(() => {
    global.fetch = jest.fn();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitySemanticService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<EntitySemanticService>(EntitySemanticService);
  });

  // ─── findSemanticMatches ────────────────────────────────────────────────────

  describe('findSemanticMatches()', () => {
    it('returns empty array when memory is not found', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      const result = await service.findSemanticMatches('mem-1', 'user-1');

      expect(result).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns empty array when embed fails (graceful degradation)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({
        raw: 'hello world',
      });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: jest.fn().mockResolvedValue('Service Unavailable'),
      });

      const result = await service.findSemanticMatches('mem-1', 'user-1');

      expect(result).toEqual([]);
    });

    it('returns empty array when no entity profiles exist', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test text' });
      mockFetchResponse({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      });
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.findSemanticMatches('mem-1', 'user-1');

      expect(result).toEqual([]);
    });

    it('returns matches above the default threshold (0.75)', async () => {
      const memVec = [1, 0, 0];
      const profileVec = [1, 0, 0]; // identical → similarity = 1.0
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: memVec }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-1', embedding: pgVector(profileVec) },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('p-1');
      expect(result[0].similarity).toBeCloseTo(1.0);
    });

    it('excludes profiles below the threshold', async () => {
      const memVec = [1, 0, 0];
      const lowVec = [0, 1, 0]; // orthogonal → similarity = 0.0
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: memVec }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-low', embedding: pgVector(lowVec) },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.75);

      expect(result).toHaveLength(0);
    });

    it('respects custom threshold parameter', async () => {
      const memVec = [1, 0, 0];
      const partialVec = [0.8, 0.6, 0]; // moderate similarity
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: memVec }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-partial', embedding: pgVector(partialVec) },
      ]);

      // With very low threshold, should match
      const result = await service.findSemanticMatches(
        'mem-1',
        'user-1',
        0.1,
      );
      expect(result.length).toBeGreaterThan(0);
    });

    it('sorts results by descending similarity', async () => {
      const memVec = [1, 0, 0];
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: memVec }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-low', embedding: pgVector([0.9, 0.44, 0]) },  // ~0.9 similarity
        { id: 'p-high', embedding: pgVector([1, 0, 0]) },       // 1.0 similarity
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.5);

      expect(result[0].profileId).toBe('p-high');
      expect(result[0].similarity).toBeGreaterThan(result[1].similarity);
    });

    it('skips profiles with null embedding gracefully', async () => {
      const memVec = [1, 0, 0];
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: memVec }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-null', embedding: null },
        { id: 'p-valid', embedding: pgVector([1, 0, 0]) },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.5);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('p-valid');
    });

    it('passes userId filter to memory query', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      await service.findSemanticMatches('mem-1', 'user-xyz');

      expect(mockPrisma.memory.findFirst).toHaveBeenCalledWith({
        where: { id: 'mem-1', userId: 'user-xyz', deletedAt: null },
        select: { raw: true },
      });
    });
  });

  // ─── embed() ───────────────────────────────────────────────────────────────

  describe('embed()', () => {
    it('returns embedding array from server response', async () => {
      const embedding = [0.1, 0.2, 0.3];
      mockFetchResponse({ data: [{ embedding }] });

      const result = await service.embed('hello world');

      expect(result).toEqual(embedding);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ input: 'hello world' }),
        }),
      );
    });

    it('throws when server returns non-ok status', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });

      await expect(service.embed('test')).rejects.toThrow(
        'Embed server error 500: Internal Server Error',
      );
    });

    it('throws when response has no data array', async () => {
      mockFetchResponse({ result: 'unexpected_format' });

      await expect(service.embed('test')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('throws when response data[0].embedding is missing', async () => {
      mockFetchResponse({ data: [{ vector: [] }] }); // wrong key

      await expect(service.embed('test')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('throws when data array is empty', async () => {
      mockFetchResponse({ data: [] });

      await expect(service.embed('test')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('uses LOCAL_EMBED_URL from config', async () => {
      // ConfigService returns http://localhost:8080 from our mock
      mockFetchResponse({ data: [{ embedding: [0.5] }] });

      await service.embed('hi');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:8080'),
        expect.anything(),
      );
    });
  });

  // ─── parseVector() (private — tested via findSemanticMatches) ──────────────

  describe('parseVector() via cosineSimilarity integration', () => {
    it('handles bracket-format Postgres vectors [0.1,0.2]', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: [1, 0] }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-1', embedding: '[1,0]' },
      ]);

      const result = await service.findSemanticMatches('m', 'u', 0.5);
      expect(result[0].similarity).toBeCloseTo(1.0);
    });

    it('handles brace-format Postgres vectors {0.1,0.2}', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: [1, 0] }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-2', embedding: '{1,0}' },
      ]);

      const result = await service.findSemanticMatches('m', 'u', 0.5);
      expect(result[0].similarity).toBeCloseTo(1.0);
    });
  });

  // ─── cosineSimilarity() (private — via findSemanticMatches) ────────────────

  describe('cosineSimilarity() edge cases', () => {
    it('returns 0 for zero vectors (avoids divide-by-zero)', async () => {
      const zeroVec = [0, 0, 0];
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: zeroVec }] });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-zero', embedding: pgVector([1, 0, 0]) },
      ]);

      // With zero memory vector, denominator = 0 → similarity = 0 → no matches above threshold
      const result = await service.findSemanticMatches('m', 'u', 0.1);
      expect(result).toHaveLength(0);
    });

    it('skips profile when dimension mismatch (catches error gracefully)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetchResponse({ data: [{ embedding: [1, 0, 0] }] }); // dim 3
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p-dim2', embedding: '[1,0]' }, // dim 2 — mismatch
        { id: 'p-dim3', embedding: '[1,0,0]' }, // dim 3 — matches
      ]);

      const result = await service.findSemanticMatches('m', 'u', 0.5);

      // Only the matching-dimension profile should be returned
      const ids = result.map((r) => r.profileId);
      expect(ids).not.toContain('p-dim2');
      expect(ids).toContain('p-dim3');
    });
  });
});
