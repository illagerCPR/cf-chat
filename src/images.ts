import {
  DEFAULT_IMAGE_RATIO,
  MAX_IMAGE_COUNT,
  MAX_PROMPT_CHARS,
  WORKERS_AI_IMAGE_MODELS,
  clampSize,
  estimateNeurons,
  findImageModel,
  findImagePreset,
  findRatio,
  type ImageModelSpec,
  type ImageProviderKind,
} from "../shared/images";
import { json, jsonError } from "./http";
import { runMockImage } from "./providers/mock-image";
import { runCompatImage } from "./providers/openai-image";
import { runWorkersAIImage } from "./providers/workers-ai-image";
import { ProviderError, errorMessage, type Env } from "./types";

interface ImagePayload {
  provider: ImageProviderKind;
  presetId?: string;
  baseUrl?: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  ratio: string;
  count: number;
  steps?: number;
  guidance?: number;
  seed?: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parseImageRequest(raw: unknown): Parsed<ImagePayload> {
  if (!isRecord(raw)) return { ok: false, message: "请求体必须是 JSON 对象。" };

  const provider = raw.provider;
  if (provider !== "workers-ai" && provider !== "openai-compatible" && provider !== "mock") {
    return { ok: false, message: "provider 不支持。" };
  }

  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return { ok: false, message: "请先写一段画面描述。" };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, message: `画面描述不能超过 ${MAX_PROMPT_CHARS} 字符。` };
  }

  const negativePrompt =
    typeof raw.negativePrompt === "string" ? raw.negativePrompt.trim().slice(0, 500) : "";

  return {
    ok: true,
    value: {
      provider,
      presetId: typeof raw.presetId === "string" ? raw.presetId.trim() : undefined,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : undefined,
      model: typeof raw.model === "string" ? raw.model.trim().slice(0, 120) : "",
      prompt,
      negativePrompt,
      ratio: typeof raw.ratio === "string" ? raw.ratio : DEFAULT_IMAGE_RATIO,
      count: Math.round(clampNumber(raw.count, 1, MAX_IMAGE_COUNT, 1)),
      steps: typeof raw.steps === "number" ? raw.steps : undefined,
      guidance: typeof raw.guidance === "number" ? raw.guidance : undefined,
      seed: typeof raw.seed === "number" && Number.isFinite(raw.seed) ? Math.round(raw.seed) : undefined,
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

interface CompatTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  spec: ImageModelSpec;
}

/**
 * Resolves the OpenAI-compatible image target.
 *
 * `spec` is only used for capability flags (size control, negative prompt), so
 * a custom endpoint falls back to a permissive default rather than refusing to
 * run.
 */
function resolveCompatTarget(payload: ImagePayload, request: Request, env: Env): CompatTarget {
  const headerKey = request.headers.get("x-provider-key")?.trim() ?? "";
  const custom = payload.presetId === "custom" || Boolean(payload.baseUrl);

  let baseUrl: string;
  let model = payload.model;

  if (custom) {
    baseUrl = resolveCustomBaseUrl(payload.baseUrl);
  } else {
    const preset = findImagePreset(payload.presetId);
    if (!preset) throw new ProviderError("请选择一个图像提供商。", 400, "unknown_preset");
    baseUrl = preset.baseUrl;
    if (!model) model = preset.models[0] ?? "";
  }

  let apiKey = headerKey;
  if (!apiKey) {
    apiKey = env.IMAGE_API_KEY?.trim() ?? "";
    if (apiKey) {
      if (!model) model = env.IMAGE_MODEL ?? "";
      if (custom && !payload.baseUrl) baseUrl = env.IMAGE_BASE_URL ?? baseUrl;
    }
  }

  if (!apiKey) {
    throw new ProviderError(
      "缺少 API Key。请在设置里填入你的密钥，或让部署者配置服务端默认密钥。",
      401,
      "missing_key",
    );
  }
  if (!model) throw new ProviderError("请填写模型名称。", 400, "missing_model");

  const known = WORKERS_AI_IMAGE_MODELS.find((item) => item.id === model);
  const spec: ImageModelSpec =
    known ??
    ({
      id: model,
      label: model,
      note: "",
      provider: "openai-compatible",
      input: "json",
      output: "base64",
      sizeControl: true,
      minEdge: 256,
      maxEdge: 2048,
      neuronsPerImage: 0,
    } satisfies ImageModelSpec);

  return { baseUrl, apiKey, model, spec };
}

async function applyRateLimit(request: Request, env: Env): Promise<Response | null> {
  const limiter = env.IMAGE_RATE_LIMITER;
  if (!limiter) return null;

  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  try {
    const { success } = await limiter.limit({ key: `image:${ip}` });
    if (success) return null;
  } catch {
    // A broken limiter must not take the endpoint down.
    return null;
  }
  return jsonError(429, "rate_limited", "画图请求太频繁了，休息一下再试。");
}

export async function handleImage(request: Request, env: Env): Promise<Response> {
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

  const parsed = parseImageRequest(raw);
  if (!parsed.ok) return jsonError(400, "invalid_request", parsed.message);

  const payload = parsed.value;
  if (payload.provider === "mock" && env.MOCK_AI !== "true") {
    return jsonError(400, "mock_disabled", "演示模式未开启。");
  }

  try {
    const ratio = findRatio(payload.ratio);

    if (payload.provider === "mock") {
      const images = [];
      for (let index = 0; index < payload.count; index += 1) {
        const image = await runMockImage({
          prompt: payload.prompt,
          negativePrompt: payload.negativePrompt,
          width: ratio.width,
          height: ratio.height,
          steps: 4,
          guidance: 0,
        });
        images.push({ ...image, width: ratio.width, height: ratio.height });
      }
      return json({
        images,
        meta: { provider: "mock", model: "mock", width: ratio.width, height: ratio.height },
      });
    }

    if (payload.provider === "openai-compatible") {
      const target = resolveCompatTarget(payload, request, env);
      const { width, height } = clampSize(target.spec, ratio);
      const images = [];
      for (let index = 0; index < payload.count; index += 1) {
        const image = await runCompatImage(
          {
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            model: target.model,
            spec: target.spec,
            request: {
              prompt: payload.prompt,
              negativePrompt: payload.negativePrompt,
              width,
              height,
              steps: payload.steps ?? target.spec.steps?.default ?? 0,
              guidance: payload.guidance ?? target.spec.guidance?.default ?? 0,
              seed: payload.seed,
            },
          },
          request.signal,
        );
        images.push({ ...image, width, height });
      }
      return json({
        images,
        meta: {
          provider: "openai-compatible",
          model: target.model,
          width,
          height,
          neurons: 0,
        },
      });
    }

    const spec =
      findImageModel(payload.model) ??
      findImageModel(env.IMAGE_MODEL) ??
      WORKERS_AI_IMAGE_MODELS[0];
    const { width, height } = clampSize(spec, ratio);
    const steps = Math.round(
      clampNumber(payload.steps, spec.steps?.min ?? 1, spec.steps?.max ?? 1, spec.steps?.default ?? 1),
    );
    const guidance = clampNumber(
      payload.guidance,
      spec.guidance?.min ?? 0,
      spec.guidance?.max ?? 10,
      spec.guidance?.default ?? 0,
    );

    const images = [];
    for (let index = 0; index < payload.count; index += 1) {
      const image = await runWorkersAIImage(
        env,
        spec,
        {
          prompt: payload.prompt,
          negativePrompt: payload.negativePrompt,
          width,
          height,
          steps,
          guidance,
          seed: payload.seed,
        },
        request.signal,
      );
      images.push({ ...image, width, height });
    }

    return json({
      images,
      meta: {
        provider: "workers-ai",
        model: spec.id,
        width,
        height,
        steps,
        neurons: estimateNeurons(spec, width, height, steps) * payload.count,
      },
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return jsonError(error.status, error.code, error.message);
    }
    return jsonError(500, "internal_error", errorMessage(error));
  }
}
