import { LMStudioProvider } from './lmstudio.provider';
import { LLMConfig, LLMMessage } from '../llm.interface';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const baseConfig: LLMConfig = {
  baseUrl: 'http://localhost:1234/v1',
  model: 'test-model',
};

const makeOkResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: jest.fn().mockResolvedValue(body),
  text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

const makeErrorResponse = (status: number, body = 'API Error') => ({
  ok: false,
  status,
  json: jest.fn(),
  text: jest.fn().mockResolvedValue(body),
});

describe('LMStudioProvider', () => {
  let provider: LMStudioProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new LMStudioProvider(baseConfig);
  });

  describe('constructor', () => {
    it('should use provided baseUrl and model', () => {
      expect(provider.name).toBe('lmstudio');
    });

    it('should use default baseUrl when not provided', () => {
      const p = new LMStudioProvider({} as LLMConfig);
      // baseUrl defaults to http://localhost:1234/v1 — verified by chat() call
      expect(p).toBeDefined();
    });

    it('should use default model when not provided', () => {
      const p = new LMStudioProvider({ baseUrl: 'http://example.com' } as LLMConfig);
      expect(p).toBeDefined();
    });
  });

  describe('chat()', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'Hello, world!' },
    ];

    it('should return parsed response on success', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: 'Hi there!' } }],
          model: 'test-model',
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      );

      const result = await provider.chat(messages);

      expect(result.content).toBe('Hi there!');
      expect(result.model).toBe('test-model');
      expect(result.usage.promptTokens).toBe(5);
      expect(result.usage.completionTokens).toBe(3);
      expect(result.usage.totalTokens).toBe(8);
    });

    it('should POST to correct endpoint', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: 'Hi' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      await provider.chat(messages);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should send messages with correct format', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: 'reply' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      await provider.chat(messages);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello, world!' }]);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(4096);
    });

    it('should allow options to override defaults', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: 'reply' } }],
          model: 'override-model',
          usage: {},
        }),
      );

      await provider.chat(messages, { model: 'override-model', temperature: 0.1, maxTokens: 100 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('override-model');
      expect(body.temperature).toBe(0.1);
      expect(body.max_tokens).toBe(100);
    });

    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));

      await expect(provider.chat(messages)).rejects.toThrow(
        'LM Studio API error: 500 - Internal Server Error',
      );
    });

    it('should handle empty choices gracefully', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [],
          model: 'test-model',
          usage: {},
        }),
      );

      const result = await provider.chat(messages);
      expect(result.content).toBe('');
    });

    it('should default usage fields to 0 when missing', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: 'reply' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      const result = await provider.chat(messages);
      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.completionTokens).toBe(0);
      expect(result.usage.totalTokens).toBe(0);
    });

    it('should use defaultModel from config when no override', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: 'reply' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      await provider.chat(messages);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('test-model');
    });
  });

  describe('json()', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'Give me JSON' },
    ];

    it('should parse valid JSON response', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: '{"key":"value"}' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      const result = await provider.json<{ key: string }>(messages);
      expect(result).toEqual({ key: 'value' });
    });

    it('should strip markdown code block from response', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: '```json\n{"name":"Rook"}\n```' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      const result = await provider.json<{ name: string }>(messages);
      expect(result).toEqual({ name: 'Rook' });
    });

    it('should strip plain code block from response', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: '```\n{"x":1}\n```' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      const result = await provider.json<{ x: number }>(messages);
      expect(result).toEqual({ x: 1 });
    });

    it('should throw when JSON is invalid', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: 'not json at all' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      await expect(provider.json(messages)).rejects.toThrow(
        'Failed to parse JSON response',
      );
    });

    it('should append JSON instruction to last user message only', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: '{}' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      const multiMessages: LLMMessage[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Extract JSON' },
      ];

      await provider.json(multiMessages);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // System message should be unchanged
      expect(body.messages[0].content).toBe('You are helpful');
      // Last user message should have JSON instruction appended
      expect(body.messages[1].content).toContain('Extract JSON');
      expect(body.messages[1].content).toContain('Respond with valid JSON only');
    });

    it('should use lower temperature for JSON mode', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: '{}' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      await provider.json(messages);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.3);
    });

    it('should allow temperature override', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          choices: [{ message: { content: '{}' } }],
          model: 'test-model',
          usage: {},
        }),
      );

      await provider.json(messages, undefined, { temperature: 0.0 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.0);
    });
  });

  describe('embed()', () => {
    it('should return embedding on success', async () => {
      const embedding = [0.1, 0.2, 0.3];
      mockFetch.mockResolvedValue(
        makeOkResponse({
          data: [{ embedding }],
          model: 'test-embed-model',
        }),
      );

      const result = await provider.embed('hello world');

      expect(result.embedding).toEqual(embedding);
      expect(result.model).toBe('test-embed-model');
      expect(result.dimensions).toBe(3);
    });

    it('should POST to /embeddings endpoint', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          data: [{ embedding: [0.1] }],
          model: 'test-model',
        }),
      );

      await provider.embed('test');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should throw on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(503, 'Service Unavailable'));

      await expect(provider.embed('test')).rejects.toThrow(
        'LM Studio Embedding API error: 503 - Service Unavailable',
      );
    });

    it('should throw when no embedding returned', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          data: [],
          model: 'test-model',
        }),
      );

      await expect(provider.embed('test')).rejects.toThrow(
        'No embedding returned',
      );
    });

    it('should throw when data is missing', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ model: 'test-model' }),
      );

      await expect(provider.embed('test')).rejects.toThrow(
        'No embedding returned',
      );
    });

    it('should use defaultModel in request body', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          data: [{ embedding: [0.1] }],
          model: 'test-model',
        }),
      );

      await provider.embed('my text');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('test-model');
      expect(body.input).toBe('my text');
    });

    it('should fallback to defaultModel if model missing in response', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          data: [{ embedding: [0.5, 0.6] }],
          // model field missing
        }),
      );

      const result = await provider.embed('test');
      expect(result.model).toBe('test-model');
    });
  });

  describe('supportsEmbeddings()', () => {
    it('should return true', () => {
      expect(provider.supportsEmbeddings()).toBe(true);
    });
  });
});
