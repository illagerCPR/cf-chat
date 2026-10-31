import { findPreset, type ChatMessage, type ProviderKind, type ThinkingMode } from "../shared/models";
import { jsonError } from "./http";
import { runMock } from "./providers/mock";
import { runOpenAICompatible } from "./providers/openai-compatible";
import { runWorkersAI } from "./providers/workers-ai";
import { sseResponse } from "./sse";
import { ProviderError, errorMessage, type Delta, type Env } from "./types";

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 120_000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 4096;
const HARD_MAX_TOKENS = 8192;

interface ChatPayload {
  provider: ProviderKind;
  presetId?: string;
  baseUrl?: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  thinking: ThinkingMode;
}

interface CompatTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface WorkersAITarget {
  model: string;
  fallbackModel?: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessages(input: unknown): Parsed<ChatMessage[]> {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, message: "messages 必须是非空数组。" };
  }
  if (input.length > MAX_MESSAGES) {
    return { ok: false, message: `一次最多发送 ${MAX_MESSAGES} 条消息。` };
  }

  const messages: ChatMessage[] = [];
  let total = 0;

  for (const item of input) {
    if (!isRecord(item)) return { ok: false, message: "消息格式不正确。" };
    const role = item.role;
    const content = item.content;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      return { ok: false, message: "消息 role 只能是 system / user / assistant。" };
    }
    if (typeof content !== "string") {
      return { ok: false, message: "消息 content 必须是字符串。" };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, message: `单条消息不能超过 ${MAX_MESSAGE_CHARS} 字符。` };
    }
    total += content.length;
    if (total > MAX_TOTAL_CHARS) {
      return { ok: false, message: "对话上下文过长，请新建会话或清空历史。" };
    }
    messages.push({ role, content });
  }

  return { ok: true, value: messages };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parseChatRequest(raw: unknown): Parsed<ChatPayload> {
  if (!isRecord(raw)) return { ok: false, message: "请求体必须是 JSON 对象。" };

  const provider = raw.provider;
  if (provider !== "workers-ai" && provider !== "openai-compatible" && provider !== "mock") {
    return { ok: false, message: "provider 不支持。" };
  }

  const messages = parseMessages(raw.messages);
  if (!messages.ok) return messages;

  const model = typeof raw.model === "string" ? raw.model.trim().slice(0, 120) : "";
  const presetId = typeof raw.presetId === "string" ? raw.presetId.trim() : undefined;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : undefined;

  return {
    ok: true,
    value: {
      provider,
      presetId,
      baseUrl,
      model,
      messages: messages.value,
      temperature: clampNumber(raw.temperature, 0, 2, DEFAULT_TEMPERATURE),
      maxTokens: Math.round(
        clampNumber(raw.maxTokens, 1, HARD_MAX_TOKENS, DEFAULT_MAX_TOKENS),
      ),
      thinking:
        raw.thinking === "on" || raw.thinking === "off" ? raw.thinking : "auto",
    },
  };
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host === "::1") return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/**
 * Custom provider URLs are only honoured for the "custom" preset, and they must
 * be public HTTPS endpoints so the Worker cannot be turned into an open proxy.
 */
function resolveCustomBaseUrl(value: string | undefined): string {
  if (!value) throw new ProviderError("自定义提供商需要填写 Base URL。", 400, "invalid_base_url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("Base URL 格式不正确。", 400, "invalid_base_url");
  }
  if (url.protocol !== "https:") {
    throw new ProviderError("Base URL 必须以 https:// 开头。", 400, "invalid_base_url");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new ProviderError("不允许指向内网地址。", 400, "invalid_base_url");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function resolveCompatTarget(
  payload: ChatPayload,
  request: Request,
  env: Env,
): CompatTarget {
  const headerKey = request.headers.get("x-provider-key")?.trim() ?? "";
  const custom = payload.presetId === "custom" || Boolean(payload.baseUrl);

  let baseUrl: string;
  let model = payload.model;

  if (custom) {
    baseUrl = resolveCustomBaseUrl(payload.baseUrl);
  } else {
    const preset = findPreset(payload.presetId);
    if (!preset) {
      throw new ProviderError("请选择一个提供商。", 400, "unknown_preset");
    }
    baseUrl = preset.baseUrl;
  }

  let apiKey = headerKey;
  if (!apiKey) {
    apiKey = env.OPENAI_COMPAT_API_KEY?.trim() ?? "";
    if (apiKey) {
      if (custom && !payload.baseUrl) baseUrl = env.OPENAI_COMPAT_BASE_URL ?? baseUrl;
      if (!model) model = env.OPENAI_COMPAT_MODEL ?? model;
    }
  }

  if (!apiKey) {
    throw new ProviderError(
      "缺少 API Key。请在设置里填入你的密钥，或让部署者配置服务端默认密钥。",
      401,
      "missing_key",
    );
  }
  if (!model) {
    throw new ProviderError("请填写模型名称。", 400, "missing_model");
  }

  return { baseUrl, apiKey, model };
}

async function* streamChat(options: {
  payload: ChatPayload;
  env: Env;
  signal: AbortSignal;
  compat?: CompatTarget;
  workersAI: WorkersAITarget;
}): AsyncGenerator<Delta> {
  const { payload, env, signal } = options;

  if (payload.provider === "mock") {
    yield { type: "meta", data: { provider: "mock", model: "mock", fallback: false } };
    yield* runMock(payload.messages, payload.thinking);
    return;
  }

  if (payload.provider === "openai-compatible" && options.compat) {
    const compat = options.compat;
    yield {
      type: "meta",
      data: { provider: "openai-compatible", model: compat.model, fallback: false },
    };
    yield* runOpenAICompatible(
      {
        baseUrl: compat.baseUrl,
        apiKey: compat.apiKey,
        model: compat.model,
        messages: payload.messages,
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        thinking: payload.thinking,
      },
      signal,
    );
    return;
  }

  const { model, fallbackModel } = options.workersAI;
  yield { type: "meta", data: { provider: "workers-ai", model, fallback: false } };

  let contentEmitted = false;
  let reasoningEmitted = false;
  try {
    for await (const delta of runWorkersAI(
      env,
      {
        model,
        messages: payload.messages,
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        thinking: payload.thinking,
      },
      signal,
    )) {
      if (delta.type === "reasoning") reasoningEmitted = true;
      else if (delta.type === "content") contentEmitted = true;
      yield delta;
    }
  } catch (error) {
    const retryable = error instanceof ProviderError ? error.retryable : true;
    if (contentEmitted || !retryable || !fallbackModel || fallbackModel === model) throw error;

    // The browser already rendered the failed attempt's reasoning; clear it
    // before the fallback model starts, or the visitor sees two thinking blocks.
    if (reasoningEmitted) yield { type: "reset" };

    yield {
      type: "meta",
      data: {
        provider: "workers-ai",
        model: fallbackModel,
        fallback: true,
        reason: errorMessage(error),
      },
    };

    yield* runWorkersAI(
      env,
      {
        model: fallbackModel,
        messages: payload.messages,
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        thinking: payload.thinking,
      },
      signal,
    );
  }
}

async function applyRateLimit(request: Request, env: Env): Promise<Response | null> {
  const limiter = env.CHAT_RATE_LIMITER;
  if (!limiter) return null;

  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  try {
    const { success } = await limiter.limit({ key: `chat:${ip}` });
    if (success) return null;
  } catch {
    // A broken limiter must not take the whole endpoint down.
    return null;
  }
  return jsonError(429, "rate_limited", "请求太频繁了，休息一下再试。");
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(405, "method_not_allowed", "只支持 POST。");
  }

  const limited = await applyRateLimit(request, env);
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "请求体不是合法的 JSON。");
  }

  const parsed = parseChatRequest(raw);
  if (!parsed.ok) return jsonError(400, "invalid_request", parsed.message);

  const payload = parsed.value;
  if (payload.provider === "mock" && env.MOCK_AI !== "true") {
    return jsonError(400, "mock_disabled", "演示模式未开启。");
  }

  try {
    const workersAI: WorkersAITarget = {
      model: payload.model || env.DEFAULT_MODEL || "@cf/qwen/qwen3-30b-a3b-fp8",
      fallbackModel: env.FALLBACK_MODEL,
    };
    const compat =
      payload.provider === "openai-compatible"
        ? resolveCompatTarget(payload, request, env)
        : undefined;

    return sseResponse(
      streamChat({ payload, env, signal: request.signal, compat, workersAI }),
      request.signal,
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      return jsonError(error.status, error.code, error.message);
    }
    return jsonError(500, "internal_error", errorMessage(error));
  }
}
