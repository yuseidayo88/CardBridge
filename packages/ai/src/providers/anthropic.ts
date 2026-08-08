import type { AiProvider, CompletionRequest, CompletionResponse } from '../provider';

/**
 * Anthropic Messages API.
 *
 * Written against the HTTP API rather than the SDK on purpose: the SDK is a
 * dependency that has to be kept current, and this uses three fields of one
 * endpoint. A fetch call is easier to reason about and to fake in tests.
 *
 * The system prompt goes in the top-level `system` field, never merged into the
 * message list. That separation is the whole prompt-injection defence — shop
 * text arrives as a user turn and cannot reach the instruction channel.
 */

const DEFAULT_MODEL = 'claude-sonnet-5';
const API_VERSION = '2023-06-01';

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  /** Per-request ceiling. Descriptions are short; this is a safety net. */
  defaultMaxTokens?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AnthropicProviderConfig) {
    if (!config.apiKey) throw new AiProviderError('ANTHROPIC_API_KEY is not set');
    this.model = config.model || DEFAULT_MODEL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.config.defaultMaxTokens ?? 2048,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    };
    // Zero by default. This job is extraction and mapping, not writing: two runs
    // over the same card should not disagree about its Item Specifics.
    body.temperature = request.temperature ?? 0;

    const payload = await this.post(body);

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');

    if (payload.stop_reason === 'max_tokens') {
      // A truncated response often still parses as JSON after repair, and a
      // silently truncated description is worse than a clean failure.
      throw new AiProviderError('response hit the max_tokens limit and was truncated');
    }

    return {
      content: extractJson(text),
      rawText: text,
      model: payload.model ?? this.model,
      inputTokens: payload.usage?.input_tokens ?? null,
      outputTokens: payload.usage?.output_tokens ?? null,
    };
  }

  private async post(body: unknown): Promise<AnthropicResponse> {
    const maxAttempts = this.config.maxAttempts ?? 3;
    const url = `${this.config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();

      if (response.ok) {
        try {
          return JSON.parse(text) as AnthropicResponse;
        } catch {
          throw new AiProviderError(`provider returned non-JSON: ${text.slice(0, 200)}`);
        }
      }

      // 429 and 5xx are worth another go; 400 means the request is wrong and
      // repeating it just spends money.
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        await sleep(backoffMs(response, attempt));
        continue;
      }

      lastError = new AiProviderError(
        `anthropic returned HTTP ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
      throw lastError;
    }

    throw lastError ?? new AiProviderError(`request failed after ${maxAttempts} attempts`);
  }
}

/**
 * Pull the JSON object out of a model response.
 *
 * Models wrap JSON in prose or a fenced block often enough that failing on it
 * would mean discarding good output. Returning the raw text when nothing parses
 * is deliberate: the schema validator downstream produces a far better message
 * than a JSON syntax error would.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  // Last resort: the outermost {...}. Indexes rather than a regex, because a
  // greedy regex over nested objects is a well-known way to lose the tail.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  return trimmed;
}

function backoffMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  return Math.min(20_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
