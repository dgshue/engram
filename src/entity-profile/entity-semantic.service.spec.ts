import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EntitySemanticService } from './entity-semantic.service';
import { PrismaService } from '../prisma/prisma.service';

// ──────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────

const mockPrisma = {
  memory: {
    findFirst: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: string) => {
    const cfg: Record<string, string> = {
      LOCAL_EMBED_URL: 'http://localhost:8080',
    };
    return cfg[key] ?? defaultValue;
  }),
};

// Global fetch mock
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Helper: build a valid embedding response
function makeEmbedResponse(embedding: number[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding }] }),
    text: async () => '',
  } as unknown as Response;
}

// ──────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────

describe('EntitySemanticService', () => {
  let service: EntitySemanticService;

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

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ────────────────────────────────────────────
  // findSemanticMatches
  // ────────────────────────────────────────────

  describe('findSemanticMatches', () => {
    const memoryId = 'mem-1';
    const userId = 'user-1';
    const vec3 = [1, 0, 0]; // unit vector

    it('returns empty array when memory not found', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      const result = await service.findSemanticMatches(memoryId, userId);

      expect(result).toEqual([]);
      expect(mockPrisma.memory.findFirst).toHaveBeenCalledWith({
        where: { id: memoryId, userId, deletedAt: null },
        select: { raw: true },
      });
    });

    it('returns empty array when embed server throws', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'hello' });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      } as unknown as Response);

      const result = await service.findSemanticMatches(memoryId, userId);

      expect(result).toEqual([]);
    });

    it('returns empty array when no entity profiles exist', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test memory' });
      mockFetch.mockResolvedValue(makeEmbedResponse(vec3));
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.findSemanticMatches(memoryId, userId);

      expect(result).toEqual([]);
    });

    it('returns matching profiles above threshold', async () => {
      const memVec = [1, 0, 0];
      const profileVec = [1, 0, 0]; // identical → similarity = 1.0

      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'relevant memory' });
      mockFetch.mockResolvedValue(makeEmbedResponse(memVec));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-1', embedding: '[1,0,0]' },
        { id: 'profile-2', embedding: '[0,1,0]' }, // orthogonal → similarity = 0
      ]);

      const result = await service.findSemanticMatches(memoryId, userId, 0.75);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('profile-1');
      expect(result[0].similarity).toBeCloseTo(1.0);
    });

    it('returns profiles sorted by descending similarity', async () => {
      // mem = [1, 1, 0] (not normalised, but cosine still works)
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 1, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'low',  embedding: '[0.5,0,0]' },   // moderate similarity
        { id: 'high', embedding: '[1,1,0]' },      // perfect similarity
      ]);

      const result = await service.findSemanticMatches(memoryId, userId, 0.5);

      expect(result[0].profileId).toBe('high');
      expect(result[1].profileId).toBe('low');
    });

    it('skips profiles with null embedding without throwing', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'no-embed', embedding: null },
        { id: 'has-embed', embedding: '[1,0,0]' },
      ]);

      const result = await service.findSemanticMatches(memoryId, userId, 0.5);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('has-embed');
    });

    it('skips profiles with malformed embedding without throwing', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'bad', embedding: '[1,0,0]' }, // dimension mismatch → should be skipped
        { id: 'ok',  embedding: '[1,0]' },
      ]);

      const result = await service.findSemanticMatches(memoryId, userId, 0.5);

      // 'bad' triggers dimension mismatch, 'ok' is fine
      expect(result.some((m) => m.profileId === 'bad')).toBe(false);
      expect(result.some((m) => m.profileId === 'ok')).toBe(true);
    });

    it('uses default threshold of 0.75 when not specified', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0, 0]));
      // Profile at 0.5 similarity (45° apart roughly)
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'below-threshold', embedding: '[1,1,0]' }, // ~0.707 similarity — above 0.75? No: cos(45°)≈0.707 < 0.75
      ]);

      const result = await service.findSemanticMatches(memoryId, userId);

      // 0.707 < 0.75, so should be excluded
      expect(result).toHaveLength(0);
    });

    it('uses curly-brace vector format from Postgres', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'curly', embedding: '{1,0,0}' }, // Postgres vector::text format
      ]);

      const result = await service.findSemanticMatches(memoryId, userId, 0.9);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('curly');
    });
  });

  // ────────────────────────────────────────────
  // embed
  // ────────────────────────────────────────────

  describe('embed', () => {
    it('returns embedding array from server', async () => {
      const expected = [0.1, 0.2, 0.3];
      mockFetch.mockResolvedValue(makeEmbedResponse(expected));

      const result = await service.embed('hello world');

      expect(result).toEqual(expected);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: 'hello world' }),
        }),
      );
    });

    it('throws when server returns non-ok status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as unknown as Response);

      await expect(service.embed('text')).rejects.toThrow(
        'Embed server error 500: Internal Server Error',
      );
    });

    it('throws when response has missing data field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: 'shape' }),
        text: async () => '',
      } as unknown as Response);

      await expect(service.embed('text')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('throws when data array is empty', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => '',
      } as unknown as Response);

      await expect(service.embed('text')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('throws when embedding field is missing from first item', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ index: 0 }] }),
        text: async () => '',
      } as unknown as Response);

      await expect(service.embed('text')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('uses configured embed URL from ConfigService', async () => {
      mockConfig.get.mockImplementation((key: string, def?: string) =>
        key === 'LOCAL_EMBED_URL' ? 'http://custom-host:9999' : def,
      );

      // Rebuild service with updated config
      const module = await Test.createTestingModule({
        providers: [
          EntitySemanticService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();
      const svc = module.get<EntitySemanticService>(EntitySemanticService);

      mockFetch.mockResolvedValue(makeEmbedResponse([1, 2, 3]));
      await svc.embed('custom url test');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom-host:9999/v1/embeddings',
        expect.anything(),
      );
    });
  });

  // ────────────────────────────────────────────
  // cosineSimilarity (tested via findSemanticMatches)
  // ────────────────────────────────────────────

  describe('cosineSimilarity (via findSemanticMatches)', () => {
    it('returns 0 for orthogonal vectors', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'ortho', embedding: '[0,1,0]' },
      ]);

      const result = await service.findSemanticMatches('m', 'u', 0);

      expect(result[0].similarity).toBeCloseTo(0);
    });

    it('returns 1 for identical vectors', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([0.5, 0.5, 0.5]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'same', embedding: '[0.5,0.5,0.5]' },
      ]);

      const result = await service.findSemanticMatches('m', 'u', 0);

      expect(result[0].similarity).toBeCloseTo(1);
    });

    it('handles zero vector gracefully (returns 0)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([0, 0, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'zero', embedding: '[1,0,0]' },
      ]);

      const result = await service.findSemanticMatches('m', 'u', 0);

      expect(result[0].similarity).toBe(0);
    });
  });
});
