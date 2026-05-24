// supabase/functions/_common/cost.ts
// AGT.1.3 — Token counting + USD cost calculation for Anthropic responses.
//
// Cost is visibility, not policy (per CONTEXT.md): we record cost on every
// log row so nous.agent_cost_summary view can roll up 1h/24h/7d aggregates.
// No ceilings; loop_guard handles runaway prevention separately.

import type { AnthropicResponseLike, AnthropicUsage } from "./types.ts";

// ─── Pricing table (USD per million tokens) ──────────────────────────────────
// Source: Anthropic public pricing as of 2026-Q2. Update here when pricing
// shifts; agent_cost_summary aggregates rebuild on next run.
// Cache-read tokens billed at 10% of input rate (Anthropic standard).

interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
}

// Resolved by longest-prefix match so version suffixes (e.g. "-20251001",
// "[1m]") still hit the right tier.
const PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-7":   { input_per_mtok: 15.00, output_per_mtok: 75.00, cache_read_per_mtok: 1.50 },
  "claude-opus-4-6":   { input_per_mtok: 15.00, output_per_mtok: 75.00, cache_read_per_mtok: 1.50 },
  "claude-opus-4":     { input_per_mtok: 15.00, output_per_mtok: 75.00, cache_read_per_mtok: 1.50 },
  "claude-sonnet-4-6": { input_per_mtok:  3.00, output_per_mtok: 15.00, cache_read_per_mtok: 0.30 },
  "claude-sonnet-4":   { input_per_mtok:  3.00, output_per_mtok: 15.00, cache_read_per_mtok: 0.30 },
  "claude-haiku-4-5":  { input_per_mtok:  1.00, output_per_mtok:  5.00, cache_read_per_mtok: 0.10 },
  "claude-haiku-4":    { input_per_mtok:  1.00, output_per_mtok:  5.00, cache_read_per_mtok: 0.10 },
};

const FALLBACK_PRICE: ModelPrice = {
  input_per_mtok: 3.00,
  output_per_mtok: 15.00,
  cache_read_per_mtok: 0.30,
};

function priceFor(model: string): ModelPrice {
  // Longest-prefix match against the table. Lets us handle "claude-opus-4-7[1m]",
  // "claude-haiku-4-5-20251001", etc. without per-suffix entries.
  let best: { len: number; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.startsWith(key) && (!best || key.length > best.len)) {
      best = { len: key.length, price };
    }
  }
  return best ? best.price : FALLBACK_PRICE;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface TokensExtract {
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/**
 * Extract token counts from an Anthropic SDK response object.
 * Returns zeros for any field absent on the response.
 * Safe against responses with no usage block (returns all zeros).
 */
export function tokensFromResponse(resp: AnthropicResponseLike | null | undefined): TokensExtract {
  const usage: AnthropicUsage | undefined = resp?.usage;
  return {
    tokens_in: usage?.input_tokens ?? 0,
    tokens_out: usage?.output_tokens ?? 0,
    cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Compute USD cost for a given (model, tokens_in, tokens_out) tuple.
 * Cache tokens are not included here — call costFromExtract for full accounting.
 * Returns a numeric (not string) suitable for postgres numeric(10,6).
 */
export function costFromTokens(model: string, tokens_in: number, tokens_out: number): number {
  const p = priceFor(model);
  const inCost = (tokens_in / 1_000_000) * p.input_per_mtok;
  const outCost = (tokens_out / 1_000_000) * p.output_per_mtok;
  return round6(inCost + outCost);
}

/**
 * Full-fidelity cost: includes cache-read tokens at the discounted rate.
 * Use this when you have a TokensExtract from tokensFromResponse.
 */
export function costFromExtract(model: string, t: TokensExtract): number {
  const p = priceFor(model);
  const inCost = (t.tokens_in / 1_000_000) * p.input_per_mtok;
  const outCost = (t.tokens_out / 1_000_000) * p.output_per_mtok;
  const cacheCost = (t.cache_read_tokens / 1_000_000) * p.cache_read_per_mtok;
  // cache_creation tokens are billed at input rate (Anthropic standard).
  const cacheCreate = (t.cache_creation_tokens / 1_000_000) * p.input_per_mtok;
  return round6(inCost + outCost + cacheCost + cacheCreate);
}

function round6(n: number): number {
  // numeric(10,6) — keep 6 decimals to avoid silent truncation surprises.
  return Math.round(n * 1_000_000) / 1_000_000;
}
