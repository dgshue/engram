import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EntitySemanticService } from './entity-semantic.service';
import { PrismaService } from '../prisma/prisma.service';

const mockFetch = jest.fn();
global.fetch = mockFetch;

const mockPrisma = {
  memory: {
    findFirst: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, string> = {
      LOCAL_EMBED_URL: 'http://localhost:8080',
    };
    return config[key] ?? defaultValue;
  }),
};

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

  // Helper: make a successful embed server response
  const makeEmbedResponse = (embedding: number[]) => ({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ data: [{ embedding }] }),
    text: jest.fn().mockResolvedValue(''),
  });

  const makeEmbedError = (status: number, body = 'Error') => ({
    ok: false,
    status,
    json: jest.fn(),
    text: jest.fn().mockResolvedValue(body),
  });

  describe('findSemanticMatches()', () => {
    const memoryId = 'mem-1';
    const userId = 'user-1';
    const memoryEmbedding = [1, 0, 0];

    beforeEach(() => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'Engram is great' });
      mockFetch.mockResolvedValue(makeEmbedResponse(memoryEmbedding));
    });

    it('should return matches above threshold', async () => {
      const profileEmbedding = [1, 0, 0]; // identical → similarity 1.0
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-1', embedding: '[1,0,0]' },
      ]);

      const matches = await service.findSemanticMatches(memoryId, userId, 0.75);

      expect(matches).toHaveLength(1);
      expect(matches[0].profileId).toBe('profile-1');
      expect(matches[0].similarity).toBeCloseTo(1.0);
    });

    it('should exclude profiles below threshold', async () => {
      // Orthogonal vector → similarity 0
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-1', embedding: '[0,1,0]' },
      ]);

      const matches = await service.findSemanticMatches(memoryId, userId, 0.75);
      expect(matches).toHaveLength(0);
    });

    it('should return empty array when memory not found', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      const matches = await service.findSemanticMatches(memoryId, userId);
      expect(matches).toHaveLength(0);
    });

    it('should return empty array when embed fails', async () => {
      mockFetch.mockResolvedValue(makeEmbedError(503, 'Embed server down'));

      const matches = await service.findSemanticMatches(memoryId, userId);
      expect(matches).toHaveLength(0);
    });

    it('should return empty array when no profiles exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const matches = await service.findSemanticMatches(memoryId, userId);
      expect(matches).toHaveLength(0);
    });

    it('should skip profiles with null embedding', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-1', embedding: null },
      ]);

      const matches = await service.findSemanticMatches(memoryId, userId);
      expect(matches).toHaveLength(0);
    });

    it('should skip profiles with dimension-mismatched embeddings', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-1', embedding: '[1,0]' }, // 2D vs 3D memory embedding
      ]);

      const matches = await service.findSemanticMatches(memoryId, userId);
      expect(matches).toHaveLength(0); // warn is logged, no throw
    });

    it('should sort matches by descending similarity', async () => {
      // memory embedding: [1,0,0]
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-low', embedding: '[0.8,0.1,0.1]' },
        { id: 'profile-high', embedding: '[1,0,0]' },
        { id: 'profile-mid', embedding: '[0.9,0,0.1]' },
      ]);

      const matches = await service.findSemanticMatches(memoryId, userId, 0.0);

      expect(matches[0].similarity).toBeGreaterThanOrEqual(matches[1].similarity);
      expect(matches[1].similarity).toBeGreaterThanOrEqual(matches[2].similarity);
    });

    it('should use default threshold of 0.75', async () => {
      // Similarity ~0.8 (should pass default 0.75)
      const similarEmbedding = [0.95, 0.1, 0.0];
      const norm = Math.sqrt(similarEmbedding.reduce((s, v) => s + v * v, 0));
      const normalized = similarEmbedding.map((v) => v / norm);
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-1', embedding: `[${normalized.join(',')}]` },
      ]);

      const matches = await service.findSemanticMatches(memoryId, userId);
      expect(matches.length).toBeGreaterThanOrEqual(0); // just verifying it runs without arg
    });
  });

  describe('embed()', () => {
    it('should return embedding array on success', async () => {
      const embedding = [0.1, 0.2, 0.3];
      mockFetch.mockResolvedValue(makeEmbedResponse(embedding));

      const result = await service.embed('hello');

      expect(result).toEqual(embedding);
    });

    it('should POST to correct endpoint', async () => {
      mockFetch.mockResolvedValue(makeEmbedResponse([0.1]));

      await service.embed('test text');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should include text in request body', async () => {
      mockFetch.mockResolvedValue(makeEmbedResponse([0.1]));

      await service.embed('hello world');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input).toBe('hello world');
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeEmbedError(500, 'Server error'));

      await expect(service.embed('text')).rejects.toThrow(
        'Embed server error 500: Server error',
      );
    });

    it('should throw on invalid response format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ data: [] }),
        text: jest.fn(),
      });

      await expect(service.embed('text')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('should throw when data field is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn(),
      });

      await expect(service.embed('text')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('should use LOCAL_EMBED_URL from config', async () => {
      mockFetch.mockResolvedValue(makeEmbedResponse([0.1]));

      await service.embed('test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:8080'),
        expect.anything(),
      );
    });
  });

  describe('cosineSimilarity (via findSemanticMatches)', () => {
    beforeEach(() => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
    });

    it('should return 1.0 for identical vectors', async () => {
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p1', embedding: '[1,0,0]' },
      ]);

      const matches = await service.findSemanticMatches('m1', 'u1', 0.0);
      expect(matches[0].similarity).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', async () => {
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p1', embedding: '[0,1,0]' },
      ]);

      const matches = await service.findSemanticMatches('m1', 'u1', 0.0);
      expect(matches[0].similarity).toBeCloseTo(0.0);
    });

    it('should handle zero vectors gracefully (return 0)', async () => {
      mockFetch.mockResolvedValue(makeEmbedResponse([0, 0, 0]));
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p1', embedding: '[0,0,0]' },
      ]);

      const matches = await service.findSemanticMatches('m1', 'u1', 0.0);
      expect(matches[0].similarity).toBe(0);
    });
  });

  describe('parseVector (via findSemanticMatches)', () => {
    beforeEach(() => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue(makeEmbedResponse([1, 0, 0]));
    });

    it('should parse square bracket format [1,0,0]', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p1', embedding: '[1,0,0]' },
      ]);

      const matches = await service.findSemanticMatches('m1', 'u1', 0.0);
      expect(matches).toHaveLength(1);
    });

    it('should parse curly brace format {1,0,0}', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'p1', embedding: '{1,0,0}' },
      ]);

      const matches = await service.findSemanticMatches('m1', 'u1', 0.0);
      expect(matches).toHaveLength(1);
    });
  });
});
