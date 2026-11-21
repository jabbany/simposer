// LLM provider abstraction. The translator only needs "system + messages in,
// text out", so any backend that can do that fits: hosted APIs, a local
// OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM), or a future
// in-browser model (WebLLM / transformers.js) implementing the same interface.

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  complete(req: CompletionRequest): Promise<string>;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export type ProviderKind = 'none' | 'anthropic' | 'openai' | 'ollama';

export interface ProviderSettings {
  kind: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export const PROVIDER_DEFAULTS: Record<ProviderKind, Omit<ProviderSettings, 'apiKey'>> = {
  none: { kind: 'none', model: '', baseUrl: '' },
  anthropic: { kind: 'anthropic', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com' },
  openai: { kind: 'openai', model: 'local-model', baseUrl: 'http://localhost:1234/v1' },
  ollama: { kind: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434' },
};

async function readError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? text);
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  return `HTTP ${res.status}${detail.length > 0 ? `: ${detail.slice(0, 300)}` : ''}`;
}

/** Claude via the Messages API, called directly from the browser with the user's key. */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic';
  private readonly s: ProviderSettings;
  constructor(settings: ProviderSettings) {
    this.s = settings;
  }

  async complete(req: CompletionRequest): Promise<string> {
    if (this.s.apiKey.length === 0) {
      throw new LlmError('Anthropic API key is not set (Settings).');
    }
    // Server-side refusal fallback is only accepted by some models.
    const fallbackModels = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
    const useFallback = fallbackModels.includes(this.s.model);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.s.apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (useFallback) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    }
    const body: Record<string, unknown> = {
      model: this.s.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      // translation is a light task; keep thinking effort low
      output_config: { effort: 'low' },
    };
    if (useFallback) {
      body['fallbacks'] = 'default';
    }
    const res = await fetch(`${this.s.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      throw new LlmError(`Anthropic ${await readError(res)}`);
    }
    const json = (await res.json()) as { stop_reason?: string; content?: { type: string; text?: string }[] };
    if (json.stop_reason === 'refusal') {
      throw new LlmError('The model declined this request.');
    }
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    if (text.trim().length === 0) {
      throw new LlmError(`empty reply (stop_reason: ${json.stop_reason ?? 'unknown'})`);
    }
    return text;
  }
}

/** Any OpenAI-compatible /chat/completions endpoint, including local servers. */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly id = 'openai';
  readonly label = 'OpenAI-compatible';
  private readonly s: ProviderSettings;
  constructor(settings: ProviderSettings) {
    this.s = settings;
  }

  /**
   * Optional request extras, dropped one at a time if the server rejects
   * them with HTTP 400 (not every OpenAI-compatible server supports both).
   *  - reasoning_effort "none": reasoning models otherwise spend the whole
   *    token budget thinking (LM Studio honors this; translation does not need it)
   *  - response_format json_schema: constrained decoding, so chatty models
   *    cannot mix prose into the command list
   */
  private extras: Record<string, unknown>[] = [
    { reasoning_effort: 'none' },
    { response_format: { type: 'json_schema', json_schema: { name: 'scene_delta', strict: true, schema: COMMANDS_SCHEMA } } },
  ];

  async complete(req: CompletionRequest): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.s.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${this.s.apiKey}`;
    }
    const send = (): Promise<Response> => fetch(`${this.s.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.assign({
        model: this.s.model,
        max_tokens: req.maxTokens,
        temperature: 0.2,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      }, ...this.extras)),
      signal: req.signal,
    });
    let res = await send();
    while (!res.ok && res.status === 400 && this.extras.length > 0) {
      this.extras = this.extras.slice(1);
      res = await send();
    }
    if (!res.ok) {
      throw new LlmError(`${this.s.baseUrl} ${await readError(res)}`);
    }
    const json = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
    const choice = json.choices?.[0];
    // some local reasoning models wrap thoughts in <think> tags
    const text = (choice?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (text.length === 0) {
      const why = choice?.finish_reason === 'length' ? ' (token budget used up, probably by model reasoning)' : '';
      throw new LlmError(`empty reply, finish_reason=${choice?.finish_reason ?? 'unknown'}${why}`);
    }
    return commandsJsonToDsl(text);
  }
}

/** JSON schema for constrained decoding: a list of command lines. */
const COMMANDS_SCHEMA = {
  type: 'object',
  properties: { commands: { type: 'array', items: { type: 'string' } } },
  required: ['commands'],
  additionalProperties: false,
};

/** Turn a `{"commands": [...]}` reply into a dsl block; pass other text through. */
function commandsJsonToDsl(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { commands?: unknown };
    if (Array.isArray(parsed.commands)) {
      const lines = parsed.commands.filter((c): c is string => typeof c === 'string');
      return `\`\`\`dsl\n${lines.join('\n')}\n\`\`\``;
    }
  } catch {
    // not JSON: the caller extracts command lines from plain text
  }
  return raw;
}

/**
 * Ollama's native chat API. Preferred over its OpenAI-compatible endpoint
 * because it lets us raise the context window (the default 4096 tokens
 * silently truncates our prompt) and turn off "thinking" output, which is
 * slow and unnecessary for this translation task.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama';
  private readonly s: ProviderSettings;
  constructor(settings: ProviderSettings) {
    this.s = settings;
  }

  async complete(req: CompletionRequest): Promise<string> {
    // Size the context to the request (about 3 chars per token, generously)
    // instead of a fixed large window, which costs memory on small machines.
    const chars = req.system.length + req.messages.reduce((a, m) => a + m.content.length, 0);
    const needed = Math.ceil(chars / 3) + req.maxTokens + 512;
    const numCtx = Math.max(4096, Math.ceil(needed / 2048) * 2048);
    const res = await fetch(`${this.s.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.s.model,
        stream: false,
        think: false,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        // Constrained decoding: the model can only emit a list of command
        // strings, which stops chatty models from mixing prose into the DSL.
        format: COMMANDS_SCHEMA,
        options: { num_ctx: numCtx, temperature: 0.2, num_predict: req.maxTokens },
      }),
      signal: req.signal,
    });
    if (!res.ok) {
      throw new LlmError(`Ollama ${await readError(res)}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    const raw = (json.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (raw.length === 0) {
      throw new LlmError('empty reply');
    }
    return commandsJsonToDsl(raw);
  }
}

export function makeProvider(s: ProviderSettings): LlmProvider | null {
  switch (s.kind) {
    case 'anthropic':
      return new AnthropicProvider(s);
    case 'openai':
      return new OpenAICompatibleProvider(s);
    case 'ollama':
      return new OllamaProvider(s);
    case 'none':
      return null;
  }
}
