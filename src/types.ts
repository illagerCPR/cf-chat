export interface Env {
  AI?: Ai;
  ASSETS?: Fetcher;
  CHAT_RATE_LIMITER?: RateLimit;

  DEFAULT_MODEL?: string;
  FALLBACK_MODEL?: string;
  MOCK_AI?: string;

  /** Optional server-side default for third-party providers. */
  OPENAI_COMPAT_BASE_URL?: string;
  OPENAI_COMPAT_API_KEY?: string;
  OPENAI_COMPAT_MODEL?: string;
}

/** One event in the normalized stream that the browser consumes. */
export type Delta =
  | { type: "meta"; data: Record<string, unknown> }
  | { type: "content"; value: string }
  | { type: "error"; message: string; code?: string };

export class ProviderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, status = 502, code = "upstream_error", retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

export function truncate(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
