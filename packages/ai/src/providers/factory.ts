import { AiProviderError, AnthropicProvider } from './anthropic';
import { OpenAiProvider } from './openai';
import type { AiProvider } from '../provider';

/**
 * Build whichever provider the environment names.
 *
 * Throws on an unknown name rather than falling back to a default vendor. A
 * deployment that intended Anthropic and silently got OpenAI would bill the
 * wrong account and produce output nobody reviewed for.
 */
export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): AiProvider {
  const name = (env.AI_PROVIDER ?? 'anthropic').toLowerCase();
  const model = env.AI_MODEL || undefined;

  switch (name) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY ?? '', model, fetchImpl });
    case 'openai':
      return new OpenAiProvider({ apiKey: env.OPENAI_API_KEY ?? '', model, fetchImpl });
    default:
      throw new AiProviderError(`unknown AI_PROVIDER "${name}"; expected "anthropic" or "openai"`);
  }
}

/**
 * Is a provider usable right now?
 *
 * Reported as data so the admin UI can say "the AI layer is not configured"
 * instead of throwing on a page that exists to explain what is missing.
 */
export function describeProviderConfig(env: NodeJS.ProcessEnv = process.env): {
  provider: string;
  model: string | null;
  configured: boolean;
  missing: string[];
} {
  const provider = (env.AI_PROVIDER ?? 'anthropic').toLowerCase();
  const missing: string[] = [];

  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  else if (provider === 'openai' && !env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  else if (provider !== 'anthropic' && provider !== 'openai') missing.push('a valid AI_PROVIDER');

  return {
    provider,
    model: env.AI_MODEL || null,
    configured: missing.length === 0,
    missing,
  };
}
