import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from '../env.js';

const TIMEOUT_MS = 90_000;

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (client) return client;
  const env = loadEnv();
  client = new Anthropic({ apiKey: env.ANTHROPIC_KEY, timeout: TIMEOUT_MS });
  return client;
}

export interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface CompletionResponse {
  text: string;
  raw: unknown;
}

export async function complete(req: CompletionRequest): Promise<CompletionResponse> {
  const c = getClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = await c.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      });
      const textParts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'text') textParts.push(block.text);
      }
      return { text: textParts.join('\n').trim(), raw: message };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) continue;
      throw err;
    }
  }
  throw lastErr ?? new Error('llmClient: unknown failure');
}
