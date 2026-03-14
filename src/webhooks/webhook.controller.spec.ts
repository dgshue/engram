import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

const mockWebhookService = {
  create: jest.fn(),
  list: jest.fn(),
  getById: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  getDeliveries: jest.fn(),
};

const mockDeliveryService = {
  sendTestEvent: jest.fn(),
};

const HEADERS_WITH_USER = { 'x-am-user-id': 'user-123' };
const HEADERS_NO_USER: Record<string, string> = {};

describe('WebhookController', () => {
  let controller: WebhookController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: WebhookDeliveryService, useValue: mockDeliveryService },
      ],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
  });

  // ─── Authorization helper ────────────────────────────────────────────────

  describe('getUserId (via each endpoint)', () => {
    it('throws UNAUTHORIZED when X-AM-User-ID header is missing on POST /', async () => {
      await expect(
        controller.create(HEADERS_NO_USER, {
          url: 'https://example.com',
          events: ['memory.created'],
        }),
      ).rejects.toThrow(
        new HttpException(
          'X-AM-User-ID header is required',
          HttpStatus.UNAUTHORIZED,
        ),
      );
    });

    it('throws UNAUTHORIZED when X-AM-User-ID header is missing on GET /', async () => {
      await expect(controller.list(HEADERS_NO_USER)).rejects.toThrow(
        new HttpException(
          'X-AM-User-ID header is required',
          HttpStatus.UNAUTHORIZED,
        ),
      );
    });

    it('throws UNAUTHORIZED when X-AM-User-ID header is missing on GET /:id', async () => {
      await expect(
        controller.getById(HEADERS_NO_USER, 'wh-1'),
      ).rejects.toThrow(
        new HttpException(
          'X-AM-User-ID header is required',
          HttpStatus.UNAUTHORIZED,
        ),
      );
    });

    it('throws UNAUTHORIZED when X-AM-User-ID header is missing on PATCH /:id', async () => {
      await expect(
        controller.update(HEADERS_NO_USER, 'wh-1', {}),
      ).rejects.toThrow(
        new HttpException(
          'X-AM-User-ID header is required',
          HttpStatus.UNAUTHORIZED,
        ),
      );
    });

    it('throws UNAUTHORIZED when X-AM-User-ID header is missing on DELETE /:id', async () => {
      await expect(
        controller.delete(HEADERS_NO_USER, 'wh-1'),
      ).rejects.toThrow(
        new HttpException(
          'X-AM-User-ID header is required',
          HttpStatus.UNAUTHORIZED,
        ),
      );
    });

    it('throws UNAUTHORIZED when X-AM-User-ID header is missing on POST /:id/test', async () => {
      await expect(
        controller.test(HEADERS_NO_USER, 'wh-1'),
      ).rejects.toThrow(
        new HttpException(
          'X-AM-User-ID header is required',
          HttpStatus.UNAUTHORIZED,
        ),
      );
    });

    it('throws UNAUTHORIZED when X-AM-User-ID header is missing on GET /:id/deliveries', async () => {
      await expect(
        controller.deliveries(HEADERS_NO_USER, 'wh-1'),
      ).rejects.toThrow(
        new HttpException(
          'X-AM-User-ID header is required',
          HttpStatus.UNAUTHORIZED,
        ),
      );
    });
  });

  // ─── POST / create ───────────────────────────────────────────────────────

  describe('create()', () => {
    const dto = { url: 'https://example.com/hook', events: ['memory.created'] };

    it('creates a webhook and returns the result', async () => {
      const created = { id: 'wh-1', userId: 'user-123', ...dto };
      mockWebhookService.create.mockResolvedValue(created);

      const result = await controller.create(HEADERS_WITH_USER, dto);

      expect(result).toEqual(created);
      expect(mockWebhookService.create).toHaveBeenCalledWith('user-123', dto);
    });

    it('throws BAD_REQUEST when service throws', async () => {
      mockWebhookService.create.mockRejectedValue(
        new Error('URL already registered'),
      );

      await expect(
        controller.create(HEADERS_WITH_USER, dto),
      ).rejects.toThrow(
        new HttpException('URL already registered', HttpStatus.BAD_REQUEST),
      );
    });

    it('includes error message in the BAD_REQUEST response', async () => {
      mockWebhookService.create.mockRejectedValue(
        new Error('Max subscriptions reached'),
      );

      try {
        await controller.create(HEADERS_WITH_USER, dto);
        fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(HttpException);
        expect(e.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(e.message).toBe('Max subscriptions reached');
      }
    });
  });

  // ─── GET / list ──────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns list of webhooks for the user', async () => {
      const webhooks = [{ id: 'wh-1' }, { id: 'wh-2' }];
      mockWebhookService.list.mockResolvedValue(webhooks);

      const result = await controller.list(HEADERS_WITH_USER);

      expect(result).toEqual(webhooks);
      expect(mockWebhookService.list).toHaveBeenCalledWith('user-123');
    });

    it('returns empty array when no webhooks exist', async () => {
      mockWebhookService.list.mockResolvedValue([]);

      const result = await controller.list(HEADERS_WITH_USER);

      expect(result).toEqual([]);
    });
  });

  // ─── GET /:id ────────────────────────────────────────────────────────────

  describe('getById()', () => {
    it('returns the webhook when found', async () => {
      const webhook = { id: 'wh-1', userId: 'user-123' };
      mockWebhookService.getById.mockResolvedValue(webhook);

      const result = await controller.getById(HEADERS_WITH_USER, 'wh-1');

      expect(result).toEqual(webhook);
      expect(mockWebhookService.getById).toHaveBeenCalledWith(
        'wh-1',
        'user-123',
      );
    });

    it('throws NOT_FOUND when webhook does not exist', async () => {
      mockWebhookService.getById.mockResolvedValue(null);

      await expect(
        controller.getById(HEADERS_WITH_USER, 'wh-999'),
      ).rejects.toThrow(
        new HttpException('Not found', HttpStatus.NOT_FOUND),
      );
    });

    it('throws NOT_FOUND when webhook belongs to another user (returns null)', async () => {
      // Service enforces user ownership — returns null for other user's webhooks
      mockWebhookService.getById.mockResolvedValue(null);

      await expect(
        controller.getById(HEADERS_WITH_USER, 'wh-other'),
      ).rejects.toThrow(
        new HttpException('Not found', HttpStatus.NOT_FOUND),
      );
    });
  });

  // ─── PATCH /:id update ───────────────────────────────────────────────────

  describe('update()', () => {
    const dto = { events: ['memory.updated'] };

    it('updates and returns the webhook', async () => {
      const updated = { id: 'wh-1', events: ['memory.updated'] };
      mockWebhookService.update.mockResolvedValue(updated);

      const result = await controller.update(HEADERS_WITH_USER, 'wh-1', dto);

      expect(result).toEqual(updated);
      expect(mockWebhookService.update).toHaveBeenCalledWith(
        'wh-1',
        'user-123',
        dto,
      );
    });

    it('throws NOT_FOUND when service throws (e.g. webhook not owned by user)', async () => {
      mockWebhookService.update.mockRejectedValue(
        new Error('Webhook not found'),
      );

      await expect(
        controller.update(HEADERS_WITH_USER, 'wh-999', dto),
      ).rejects.toThrow(
        new HttpException('Webhook not found', HttpStatus.NOT_FOUND),
      );
    });
  });

  // ─── DELETE /:id ─────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('deletes the webhook and returns the result', async () => {
      const deleted = { id: 'wh-1', deleted: true };
      mockWebhookService.delete.mockResolvedValue(deleted);

      const result = await controller.delete(HEADERS_WITH_USER, 'wh-1');

      expect(result).toEqual(deleted);
      expect(mockWebhookService.delete).toHaveBeenCalledWith(
        'wh-1',
        'user-123',
      );
    });

    it('throws NOT_FOUND when service throws', async () => {
      mockWebhookService.delete.mockRejectedValue(
        new Error('Not found or not yours'),
      );

      await expect(
        controller.delete(HEADERS_WITH_USER, 'wh-999'),
      ).rejects.toThrow(
        new HttpException('Not found or not yours', HttpStatus.NOT_FOUND),
      );
    });
  });

  // ─── POST /:id/test ──────────────────────────────────────────────────────

  describe('test()', () => {
    it('sends a test event and returns result', async () => {
      const testResult = { delivered: true, statusCode: 200 };
      mockDeliveryService.sendTestEvent.mockResolvedValue(testResult);

      const result = await controller.test(HEADERS_WITH_USER, 'wh-1');

      expect(result).toEqual(testResult);
      expect(mockDeliveryService.sendTestEvent).toHaveBeenCalledWith(
        'wh-1',
        'user-123',
      );
    });

    it('throws NOT_FOUND when delivery service throws', async () => {
      mockDeliveryService.sendTestEvent.mockRejectedValue(
        new Error('Webhook subscription not found'),
      );

      await expect(
        controller.test(HEADERS_WITH_USER, 'wh-99'),
      ).rejects.toThrow(
        new HttpException(
          'Webhook subscription not found',
          HttpStatus.NOT_FOUND,
        ),
      );
    });
  });

  // ─── GET /:id/deliveries ─────────────────────────────────────────────────

  describe('deliveries()', () => {
    it('returns deliveries with default limit of 50', async () => {
      const logs = [{ id: 'd-1' }, { id: 'd-2' }];
      mockWebhookService.getDeliveries.mockResolvedValue(logs);

      const result = await controller.deliveries(HEADERS_WITH_USER, 'wh-1');

      expect(result).toEqual(logs);
      expect(mockWebhookService.getDeliveries).toHaveBeenCalledWith(
        'wh-1',
        'user-123',
        50,
      );
    });

    it('respects custom limit query param', async () => {
      mockWebhookService.getDeliveries.mockResolvedValue([]);

      await controller.deliveries(HEADERS_WITH_USER, 'wh-1', '10');

      expect(mockWebhookService.getDeliveries).toHaveBeenCalledWith(
        'wh-1',
        'user-123',
        10,
      );
    });

    it('parses limit as integer (not string)', async () => {
      mockWebhookService.getDeliveries.mockResolvedValue([]);

      await controller.deliveries(HEADERS_WITH_USER, 'wh-1', '25');

      const callArgs = mockWebhookService.getDeliveries.mock.calls[0];
      expect(typeof callArgs[2]).toBe('number');
      expect(callArgs[2]).toBe(25);
    });

    it('throws NOT_FOUND when service throws', async () => {
      mockWebhookService.getDeliveries.mockRejectedValue(
        new Error('Webhook not found'),
      );

      await expect(
        controller.deliveries(HEADERS_WITH_USER, 'wh-999'),
      ).rejects.toThrow(
        new HttpException('Webhook not found', HttpStatus.NOT_FOUND),
      );
    });
  });
});
