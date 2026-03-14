import { LMStudioProvider } from './lmstudio.provider';
import { LLMConfig, LLMMessage } from '../llm.interface';

// ─── fetch mock helpers ────────────────────────────────────────────────────────

const mockFetch = (body: unknown, ok = true, status = 200) => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    json: jest.fn().mockResolvedValue(body),
  });
};

const USER_MSG: LLMMessage = { role: 'user', content: 'Hello' };

describe('LMStudioProvider', () => {
  let provider: LMStudioProvider;

  beforeAll(() => {
    global.fetch = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new LMStudioProvider({});
  });

  // ─── constructor defaults ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('uses default baseUrl and model when config is empty', () => {
      expect(provider.name).toBe('lmstudio');
    });

    it('uses custom baseUrl when provided', async () => {
      const custom = new LMStudioProvider({
        baseUrl: 'http://custom:9999/v1',
        model: 'my-model',
      });
      mockFetch({
        choices: [{ message: { content: 'hi' } }],
        model: 'my-model',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await custom.chat([USER_MSG]);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom:9999/v1/chat/completions',
        expect.anything(),
      );
    });
  });

  // ─── chat() ────────────────────────────────────────────────────────────────

  describe('chat()', () => {
    const chatResponse = {
      choices: [{ message: { content: 'World!' } }],
      model: 'local-model',
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
    };

    it('sends a POST to /chat/completions and returns structured response', async () => {
      mockFetch(chatResponse);

      const result = await provider.chat([USER_MSG]);

      expect(result.content).toBe('World!');
      expect(result.model).toBe('local-model');
      expect(result.usage.promptTokens).toBe(5);
      expect(result.usage.completionTokens).toBe(3);
      expect(result.usage.totalTokens).toBe(8);
    });

    it('sends correct request body with defaults', async () => {
      mockFetch(chatResponse);

      await provider.chat([USER_MSG]);

      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      expect(body.model).toBe('local-model');
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(4096);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('respects options overrides (model, temperature, maxTokens)', async () => {
      mockFetch(chatResponse);

      await provider.chat([USER_MSG], {
        model: 'llama3',
        temperature: 0.2,
        maxTokens: 512,
      });

      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      expect(body.model).toBe('llama3');
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(512);
    });

    it('throws on non-ok response', async () => {
      mockFetch('Model not loaded', false, 503);

      await expect(provider.chat([USER_MSG])).rejects.toThrow(
        'LM Studio API error: 503 - Model not loaded',
      );
    });

    it('returns empty string content when choices[0].message.content is missing', async () => {
      mockFetch({ choices: [{ message: {} }], model: 'x', usage: {} });

      const result = await provider.chat([USER_MSG]);

      expect(result.content).toBe('');
    });

    it('returns zero usage tokens when usage is missing', async () => {
      mockFetch({ choices: [{ message: { content: 'hi' } }], model: 'x' });

      const result = await provider.chat([USER_MSG]);

      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.completionTokens).toBe(0);
      expect(result.usage.totalTokens).toBe(0);
    });

    it('falls back to defaultModel when response.model is absent', async () => {
      mockFetch({ choices: [{ message: { content: 'hi' } }] });

      const result = await provider.chat([USER_MSG]);

      expect(result.model).toBe('local-model');
    });

    it('passes multiple messages correctly', async () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is 2+2?' },
      ];
      mockFetch(chatResponse);

      await provider.chat(messages);

      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
    });
  });

  // ─── json() ────────────────────────────────────────────────────────────────

  describe('json()', () => {
    it('parses clean JSON response', async () => {
      mockFetch({
        choices: [{ message: { content: '{"name":"Alice","age":30}' } }],
        model: 'x',
        usage: {},
      });

      const result = await provider.json<{ name: string; age: number }>([
        USER_MSG,
      ]);

      expect(result.name).toBe('Alice');
      expect(result.age).toBe(30);
    });

    it('strips markdown code fences from response', async () => {
      mockFetch({
        choices: [
          { message: { content: '```json\n{"key":"value"}\n```' } },
        ],
        model: 'x',
        usage: {},
      });

      const result = await provider.json<{ key: string }>([USER_MSG]);

      expect(result.key).toBe('value');
    });

    it('strips plain code fences (no language tag)', async () => {
      mockFetch({
        choices: [{ message: { content: '```\n{"x":1}\n```' } }],
        model: 'x',
        usage: {},
      });

      const result = await provider.json<{ x: number }>([USER_MSG]);
      expect(result.x).toBe(1);
    });

    it('throws when response cannot be parsed as JSON', async () => {
      mockFetch({
        choices: [{ message: { content: 'Sorry, I cannot do that.' } }],
        model: 'x',
        usage: {},
      });

      await expect(provider.json([USER_MSG])).rejects.toThrow(
        'Failed to parse JSON response',
      );
    });

    it('appends JSON instruction to last user message only', async () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Give me data.' },
      ];
      mockFetch({
        choices: [{ message: { content: '{"ok":true}' } }],
        model: 'x',
        usage: {},
      });

      await provider.json([...messages]);

      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      // System message unchanged
      expect(body.messages[0].content).toBe('Be concise.');
      // Last user message has JSON instruction appended
      expect(body.messages[1].content).toContain('Give me data.');
      expect(body.messages[1].content).toContain('Respond with valid JSON only');
    });

    it('uses lower default temperature (0.3) for JSON calls', async () => {
      mockFetch({
        choices: [{ message: { content: '{}' } }],
        model: 'x',
        usage: {},
      });

      await provider.json([USER_MSG]);

      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      expect(body.temperature).toBe(0.3);
    });

    it('propagates fetch errors from underlying chat() call', async () => {
      mockFetch('Server error', false, 500);

      await expect(provider.json([USER_MSG])).rejects.toThrow(
        'LM Studio API error: 500',
      );
    });
  });

  // ─── embed() ───────────────────────────────────────────────────────────────

  describe('embed()', () => {
    it('returns embedding, model, and dimensions', async () => {
      const embedding = [0.1, 0.2, 0.3, 0.4];
      mockFetch({
        data: [{ embedding }],
        model: 'embed-model',
      });

      const result = await provider.embed('test input');

      expect(result.embedding).toEqual(embedding);
      expect(result.model).toBe('embed-model');
      expect(result.dimensions).toBe(4);
    });

    it('sends to /embeddings endpoint', async () => {
      mockFetch({ data: [{ embedding: [0.1] }], model: 'x' });

      await provider.embed('hi');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/embeddings',
        expect.anything(),
      );
    });

    it('sends correct request body', async () => {
      mockFetch({ data: [{ embedding: [0.5] }], model: 'x' });

      await provider.embed('hello');

      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      expect(body.input).toBe('hello');
      expect(body.model).toBe('local-model');
    });

    it('throws on non-ok response with helpful message including model load hint', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue('Not Found'),
        json: jest.fn().mockResolvedValue('Not Found'),
      });

      let errorMessage = '';
      try {
        await provider.embed('test');
      } catch (e: any) {
        errorMessage = e.message;
      }

      // Restore single-shot mock
      (global.fetch as jest.Mock).mockReset();

      expect(errorMessage).toContain('LM Studio Embedding API error: 404');
      expect(errorMessage).toContain('Make sure an embedding model is loaded');
    });

    it('throws when response has no embedding data', async () => {
      mockFetch({ data: [] });

      await expect(provider.embed('test')).rejects.toThrow(
        'No embedding returned. Load an embedding model in LM Studio.',
      );
    });

    it('throws when data[0].embedding is missing', async () => {
      mockFetch({ data: [{ something_else: [] }] });

      await expect(provider.embed('test')).rejects.toThrow(
        'No embedding returned',
      );
    });

    it('falls back to defaultModel when response.model is absent', async () => {
      mockFetch({ data: [{ embedding: [0.1, 0.2] }] });

      const result = await provider.embed('hi');

      expect(result.model).toBe('local-model');
    });

    it('calculates dimensions from embedding length', async () => {
      const embedding = new Array(1536).fill(0.01);
      mockFetch({ data: [{ embedding }], model: 'x' });

      const result = await provider.embed('long input');

      expect(result.dimensions).toBe(1536);
    });
  });

  // ─── supportsEmbeddings() ──────────────────────────────────────────────────

  describe('supportsEmbeddings()', () => {
    it('returns true (always reports embedding capability)', () => {
      expect(provider.supportsEmbeddings()).toBe(true);
    });
  });
});
