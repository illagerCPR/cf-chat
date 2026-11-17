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
  /** Reference images for image-to-image, base64 without the data: prefix. */
  inputImages?: { base64: string; mimeType: string }[];
}

/** Each reference image is capped at 512x512 by the model, so the bytes stay small. */
const MAX_INPUT_IMAGE_BYTES = 1_500_000;

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseInputImages(raw: unknown): Parsed<{ base64: string; mimeType: string }[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "参考图格式不正确。" };
  if (raw.length > 4) return { ok: false, message: "参考图最多 4 张。" };

  const images: { base64: string; mimeType: string }[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.base64 !== "string" || !item.base64) {
      return { ok: false, message: "参考图数据不完整。" };
    }
    // Base64 is 4/3 of the byte size; this keeps one request well under the
    // Worker's memory ceiling without decoding anything.
    if (item.base64.length > MAX_INPUT_IMAGE_BYTES) {
      return { ok: false, message: "参考图太大了，请换一张更小的。" };
    }
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : "image/png";
    if (!mimeType.startsWith("image/")) {
      return { ok: false, message: "参考图必须是图片。" };
    }
    images.push({ base64: item.base64, mimeType });
  }
  return { ok: true, value: images };
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

  const inputImages = parseInputImages(raw.inputImages);
  if (!inputImages.ok) return { ok: false, message: inputImages.message };

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
      inputImages: inputImages.value,
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
          inputImages: payload.inputImages,
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
        images.push({
          ...image,
          width: image.width ?? width,
          height: image.height ?? height,
        });
      }
      return json({
        images,
        meta: {
          provider: "openai-compatible",
          model: target.model,
          width: images[0].width,
          height: images[0].height,
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

    const inputImages = payload.inputImages ?? [];
    if (inputImages.length > 0) {
      const limit = spec.maxInputImages ?? 0;
      if (limit === 0) {
        throw new ProviderError(
          `${spec.label} 不支持参考图，请换用 FLUX.2 系列模型。`,
          400,
          "input_image_unsupported",
        );
      }
      if (inputImages.length > limit) {
        throw new ProviderError(
          `${spec.label} 最多接受 ${limit} 张参考图。`,
          400,
          "too_many_input_images",
        );
      }
    }

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
          inputImages,
        },
        request.signal,
      );
      // The requested size is only a hint: flux-1-schnell ignores it and always
      // answers 1024x1024, so the real size from the bytes wins when available.
      images.push({
        ...image,
        width: image.width ?? width,
        height: image.height ?? height,
      });
    }

    const actual = images[0];
    return json({
      images,
      meta: {
        provider: "workers-ai",
        model: spec.id,
        width: actual.width,
        height: actual.height,
        steps,
        neurons: estimateNeurons(spec, actual.width, actual.height, steps) * payload.count,
      },
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return jsonError(error.status, error.code, error.message);
    }
    return jsonError(500, "internal_error", errorMessage(error));
  }
}
