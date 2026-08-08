import { AiProviderError, extractJson } from './anthropic';
import type { AiProvider, CompletionRequest, CompletionResponse } from '../provider';

/**
 * OpenAI Chat Completions.
 *
 * Present so that the provider choice is genuinely a configuration change. The
 * validation chain, hallucination guard and audit trail live in provider.ts and
 * apply identically here — swapping vendors cannot swap out the safety checks.
 */

const DEFAULT_MODEL = 'gpt-4o';

export interface OpenAiProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  defaultMaxTokens?: number;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  readonly model: string;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenAiProviderConfig) {
    if (!config.apiKey) throw new AiProviderError('OPENAI_API_KEY is not set');
    this.model = config.model || DEFAULT_MODEL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      // The system role keeps instructions out of the same channel as the shop
      // text, matching how the Anthropic provider separates them.
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      max_tokens: request.maxTokens ?? this.config.defaultMaxTokens ?? 2048,
      temperature: request.temperature ?? 0,
    };

    // Ask for JSON when the caller supplied a schema. json_object is supported
    // far more widely than json_schema, and the schema validator downstream is
    // authoritative either way.
    if (request.jsonSchema) body.response_format = { type: 'json_object' };

    const payload = await this.post(body);
    const choice = payload.choices?.[0];

    if (choice?.finish_reason === 'length') {
      throw new AiProviderError('response hit the token limit and was truncated');
    }

    const text = choice?.message?.content ?? '';

    return {
      content: extractJson(text),
      rawText: text,
      model: payload.model ?? this.model,
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
    };
  }

  private async post(body: unknown): Promise<OpenAiResponse> {
    const maxAttempts = this.config.maxAttempts ?? 3;
    const url = `${this.config.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();

      if (response.ok) {
        try {
          return JSON.parse(text) as OpenAiResponse;
        } catch {
          throw new AiProviderError(`provider returned non-JSON: ${text.slice(0, 200)}`);
        }
      }

      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        await sleep(Math.min(20_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
        continue;
      }

      lastError = new AiProviderError(
        `openai returned HTTP ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
      throw lastError;
    }

    throw lastError ?? new AiProviderError(`request failed after ${maxAttempts} attempts`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
