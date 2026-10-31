/**
 * Token accounting shared by the Worker and the browser.
 *
 * Numbers come from the provider when the stream reports usage. Some providers
 * and some Workers AI models do not, so the fallback is a character estimate
 * flagged with `estimated`. The heuristic follows DeepSeek's published rule of
 * thumb: one CJK character ≈ 0.6 token, one ASCII character ≈ 0.3 token.
 */

export interface Usage {
  /** Tokens sent upstream for this turn: system prompt plus visible history. */
  promptTokens: number;
  /** Tokens the model produced, chain of thought included. */
  completionTokens: number;
  totalTokens: number;
  /** Part of `completionTokens` spent on reasoning, when the provider says so. */
  reasoningTokens?: number;
  /** True when the numbers come from the character heuristic, not the provider. */
  estimated: boolean;
}

/** A usage payload as sent by OpenAI-compatible APIs. */
export interface RawUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Normalizes either snake_case (OpenAI) or camelCase usage objects. */
export function readUsage(raw: unknown): RawUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const details = record.completion_tokens_details as Record<string, unknown> | undefined;
  const prompt =
    finiteNumber(record.prompt_tokens) ?? finiteNumber(record.promptTokens);
  const completion =
    finiteNumber(record.completion_tokens) ?? finiteNumber(record.completionTokens);
  if (prompt === null && completion === null) return null;

  const total = finiteNumber(record.total_tokens) ?? finiteNumber(record.totalTokens);
  const reasoning =
    finiteNumber(details?.reasoning_tokens) ?? finiteNumber(record.reasoning_tokens);

  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    totalTokens: total ?? (prompt ?? 0) + (completion ?? 0),
    ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
  };
}

/** Builds a `Usage` from a provider payload, or returns null when absent. */
export function providerUsage(raw: unknown): Usage | null {
  const parsed = readUsage(raw);
  if (!parsed) return null;
  return { ...parsed, estimated: false };
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, kana, ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // Fullwidth forms
  );
}

/** Rough token count for a piece of text; used when no provider usage exists. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let units = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (isWideCodePoint(code)) units += 0.6;
    else if (code >= 0x1f000) units += 2; // emoji and other pictographs
    else units += 0.3;
  }
  return Math.ceil(units);
}

/** Approximate prompt size of a chat request, including per-message overhead. */
export function estimatePromptTokens(messages: Array<{ role?: string; content: string }>): number {
  let total = 3;
  for (const message of messages) {
    total += 4 + estimateTextTokens(message.content) + estimateTextTokens(message.role ?? "");
  }
  return total;
}

/** Builds an estimated `Usage` for a completed turn. */
export function estimatedUsage(promptTokens: number, outputText: string): Usage {
  const completionTokens = estimateTextTokens(outputText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

export function formatTokens(value: number): string {
  return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
