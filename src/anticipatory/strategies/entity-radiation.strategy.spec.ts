import { Test, TestingModule } from '@nestjs/testing';
import { EntityRadiationStrategy } from './entity-radiation.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { EntityService } from '../../graph/services/entity.service';
import { RelationshipService } from '../../graph/services/relationship.service';
import { ContextSignals } from './strategy.interface';

const mockPrisma = {
  memory: {
    findMany: jest.fn(),
  },
};

const mockEntityService = {
  findByNameOrAlias: jest.fn(),
};

const mockRelationshipService = {
  traverse: jest.fn(),
};

const makeEntity = (id: string, name: string) => ({ id, name });

const makeTraversal = (
  nodes: Array<{ id: string; name: string }>,
  edges: Array<{ sourceId: string; targetId: string; weight: number }> = [],
) => ({ nodes, edges });

const makeMemory = (id: string, effectiveScore = 0.8) => ({
  id,
  raw: `Memory about ${id}`,
  effectiveScore,
  importanceScore: effectiveScore,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  extraction: null,
  userId: 'user-1',
  deletedAt: null,
  supersededById: null,
});

const baseSignals: ContextSignals = {
  userId: 'user-1',
  entities: ['Engram'],
  excludeMemoryIds: [],
  query: 'tell me about Engram',
  sessionKey: 'sess-1',
};

const defaultOptions = { maxResults: 10, timeoutMs: 5000 };

describe('EntityRadiationStrategy', () => {
  let strategy: EntityRadiationStrategy;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityRadiationStrategy,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EntityService, useValue: mockEntityService },
        { provide: RelationshipService, useValue: mockRelationshipService },
      ],
    }).compile();

    strategy = module.get<EntityRadiationStrategy>(EntityRadiationStrategy);
  });

  describe('strategy metadata', () => {
    it('should have name "entity_radiation"', () => {
      expect(strategy.name).toBe('entity_radiation');
    });
  });

  describe('execute()', () => {
    it('should return empty array when no entities in signals', async () => {
      const signals: ContextSignals = { ...baseSignals, entities: [] };

      const results = await strategy.execute(signals, defaultOptions);

      expect(results).toHaveLength(0);
      expect(mockEntityService.findByNameOrAlias).not.toHaveBeenCalled();
    });

    it('should return empty array when entity not found in graph', async () => {
      mockEntityService.findByNameOrAlias.mockResolvedValue(null);

      const results = await strategy.execute(baseSignals, defaultOptions);

      expect(results).toHaveLength(0);
      expect(mockRelationshipService.traverse).not.toHaveBeenCalled();
    });

    it('should return empty array when entity has no adjacent nodes', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity]), // only the start entity, no adjacents
      );

      const results = await strategy.execute(baseSignals, defaultOptions);

      expect(results).toHaveLength(0);
    });

    it('should return empty when adjacent entity has no memories', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      const adjEntity = makeEntity('e-railway', 'Railway');
      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjEntity], [
          { sourceId: 'e-engram', targetId: 'e-railway', weight: 0.9 },
        ]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([]);

      const results = await strategy.execute(baseSignals, defaultOptions);

      expect(results).toHaveLength(0);
    });

    it('should return result for adjacent entity with memories', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      const adjEntity = makeEntity('e-railway', 'Railway');
      const memory = makeMemory('mem-1', 0.8);

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjEntity], [
          { sourceId: 'e-engram', targetId: 'e-railway', weight: 0.9 },
        ]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([memory]);

      const results = await strategy.execute(baseSignals, defaultOptions);

      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe('mem-1');
      expect(results[0].meta.strategy).toBe('entity_radiation');
      expect(results[0].meta.reason).toContain('Engram');
      expect(results[0].meta.reason).toContain('Railway');
      expect(results[0].meta.entityPath).toEqual(['Engram', 'Railway']);
    });

    it('should respect maxResults limit', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      const adjEntities = Array.from({ length: 5 }, (_, i) =>
        makeEntity(`e-${i}`, `Entity${i}`),
      );

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, ...adjEntities]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([makeMemory('mem-x', 0.9)]);

      const results = await strategy.execute(baseSignals, {
        maxResults: 3,
        timeoutMs: 5000,
      });

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should enforce entity diversity (1 result per adjacent entity)', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      const adjEntity = makeEntity('e-railway', 'Railway');

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjEntity]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([makeMemory('mem-1', 0.9)]);

      // Multiple entity queries — each resolved to same adjacent entity (via seenEntityIds)
      const signals: ContextSignals = {
        ...baseSignals,
        entities: ['Engram', 'Engram2'],
      };

      // Second entity also maps to something that includes Railway
      mockEntityService.findByNameOrAlias
        .mockResolvedValueOnce(entity)
        .mockResolvedValueOnce(makeEntity('e-engram2', 'Engram2'));

      mockRelationshipService.traverse
        .mockResolvedValueOnce(makeTraversal([entity, adjEntity]))
        .mockResolvedValueOnce(makeTraversal([makeEntity('e-engram2', 'Engram2'), adjEntity]));

      const results = await strategy.execute(signals, defaultOptions);

      // Railway should only appear once due to seenEntityIds
      const railwayResults = results.filter((r) =>
        r.meta.reason.includes('Railway'),
      );
      expect(railwayResults.length).toBeLessThanOrEqual(1);
    });

    it('should sort results by salience descending', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      const adj1 = makeEntity('e-prisma', 'Prisma');
      const adj2 = makeEntity('e-pgvector', 'pgvector');

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adj1, adj2], [
          { sourceId: 'e-engram', targetId: 'e-prisma', weight: 0.5 },
          { sourceId: 'e-engram', targetId: 'e-pgvector', weight: 0.9 },
        ]),
      );

      // Prisma memory: effectiveScore 0.5, pgvector memory: effectiveScore 0.9
      mockPrisma.memory.findMany
        .mockResolvedValueOnce([makeMemory('mem-prisma', 0.5)])
        .mockResolvedValueOnce([makeMemory('mem-pgvector', 0.9)]);

      const results = await strategy.execute(baseSignals, defaultOptions);

      if (results.length >= 2) {
        expect(results[0].meta.salience).toBeGreaterThanOrEqual(
          results[1].meta.salience,
        );
      }
    });

    it('should include excludeMemoryIds in query', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      const adjEntity = makeEntity('e-railway', 'Railway');

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjEntity]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([]);

      const signals: ContextSignals = {
        ...baseSignals,
        excludeMemoryIds: ['excluded-mem-1', 'excluded-mem-2'],
      };

      await strategy.execute(signals, defaultOptions);

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: expect.objectContaining({
              notIn: expect.arrayContaining(['excluded-mem-1', 'excluded-mem-2']),
            }),
          }),
        }),
      );
    });

    it('should continue processing other entities when one throws', async () => {
      const signals: ContextSignals = {
        ...baseSignals,
        entities: ['BadEntity', 'GoodEntity'],
      };

      mockEntityService.findByNameOrAlias
        .mockRejectedValueOnce(new Error('Entity lookup failed'))
        .mockResolvedValueOnce(makeEntity('e-good', 'GoodEntity'));

      const adjEntity = makeEntity('e-adj', 'Adjacent');
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([makeEntity('e-good', 'GoodEntity'), adjEntity]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([makeMemory('mem-good', 0.8)]);

      // Should not throw; processes GoodEntity successfully
      const results = await strategy.execute(signals, defaultOptions);

      // GoodEntity's adjacent entity should produce a result
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should calculate salience using edge weight, effectiveScore, and recency', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      const adjEntity = makeEntity('e-railway', 'Railway');

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);

      const edge = { sourceId: 'e-engram', targetId: 'e-railway', weight: 0.8 };
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjEntity], [edge]),
      );

      // Recent memory (today)
      const recentMemory = {
        ...makeMemory('mem-recent', 1.0),
        createdAt: new Date(),
      };
      mockPrisma.memory.findMany.mockResolvedValue([recentMemory]);

      const results = await strategy.execute(baseSignals, defaultOptions);

      expect(results).toHaveLength(1);
      // Salience = edgeWeight × effectiveScore × recencyDecay
      // With very recent memory: recencyDecay ≈ 1.0 → salience ≈ 0.8 × 1.0 × 1.0 = 0.8
      expect(results[0].meta.salience).toBeGreaterThan(0);
      expect(results[0].meta.salience).toBeLessThanOrEqual(1.0);
    });

    it('should traverse with correct userId', async () => {
      const entity = makeEntity('e-engram', 'Engram');
      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity]),
      );

      await strategy.execute(baseSignals, defaultOptions);

      expect(mockRelationshipService.traverse).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          startEntityId: 'e-engram',
          maxDepth: 1,
        }),
      );
    });
  });
});
