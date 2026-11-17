import type { ImageModelSpec } from "../../shared/images";
import { ProviderError, errorMessage, type Env } from "../types";

export interface ImageRequest {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed?: number;
}

export interface GeneratedImage {
  /** Base64 payload without the `data:` prefix. */
  base64: string;
  mimeType: string;
}

const DEFAULT_MIME = "image/png";

/** Sniffs the image type from the first bytes of a base64 payload. */
export function sniffMime(base64: string): string {
  const head = base64.slice(0, 24);
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("UklGR")) return "image/webp";
  if (head.startsWith("R0lGOD")) return "image/gif";
  return DEFAULT_MIME;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked so a multi-megabyte image does not blow the argument limit of
  // String.fromCharCode.
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function readBinary(value: unknown): Promise<GeneratedImage | null> {
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return bytes.length ? { base64: toBase64(bytes), mimeType: sniffMime(toBase64(bytes)) } : null;
  }
  if (value instanceof Uint8Array) {
    return value.length
      ? { base64: toBase64(value), mimeType: sniffMime(toBase64(value)) }
      : null;
  }
  if (value instanceof Blob) {
    const buffer = new Uint8Array(await value.arrayBuffer());
    if (!buffer.length) return null;
    const base64 = toBase64(buffer);
    return { base64, mimeType: value.type || sniffMime(base64) };
  }
  return null;
}

/**
 * Pulls an image out of whatever `ai.run` returned.
 *
 * The catalog is inconsistent here: most models answer `{ image: "<base64>" }`,
 * `phoenix-1.0` answers raw JPEG bytes, and the binding may hand back a
 * `ReadableStream` for binary outputs. All of it converges to base64 + mime.
 */
async function extractImage(result: unknown): Promise<GeneratedImage | null> {
  if (result === null || result === undefined) return null;

  const direct = await readBinary(result);
  if (direct) return direct;

  if (typeof result === "object") {
    const record = result as Record<string, unknown>;

    // A streamed binary body: drain it, then sniff.
    const stream = record.body ?? record.stream;
    if (stream && typeof (stream as ReadableStream).getReader === "function") {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.length;
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
      if (!total) return null;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const base64 = toBase64(merged);
      return { base64, mimeType: sniffMime(base64) };
    }

    const image = record.image;
    if (typeof image === "string" && image) {
      // Some models prefix the payload with a data URL.
      const comma = image.startsWith("data:") ? image.indexOf(",") : -1;
      const base64 = comma >= 0 ? image.slice(comma + 1) : image;
      const declared = comma >= 0 ? image.slice(5, comma).split(";")[0] : "";
      return { base64, mimeType: declared || sniffMime(base64) };
    }

    const nested = await readBinary(record.data);
    if (nested) return nested;
  }

  return null;
}

function buildForm(request: ImageRequest, spec: ImageModelSpec): FormData {
  const form = new FormData();
  form.append("prompt", request.prompt);
  if (spec.sizeControl) {
    form.append("width", String(request.width));
    form.append("height", String(request.height));
  }
  if (spec.steps) form.append("steps", String(request.steps));
  if (spec.guidance) form.append("guidance", String(request.guidance));
  if (request.seed !== undefined) form.append("seed", String(request.seed));
  return form;
}

function buildJson(request: ImageRequest, spec: ImageModelSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: request.prompt };
  if (spec.sizeControl) {
    body.width = request.width;
    body.height = request.height;
  }
  if (spec.steps) body.steps = request.steps;
  if (spec.guidance) body.guidance = request.guidance;
  if (spec.negativePrompt && request.negativePrompt) {
    body.negative_prompt = request.negativePrompt;
  }
  if (request.seed !== undefined) body.seed = request.seed;
  return body;
}

/**
 * Runs one Workers AI image model.
 *
 * The multipart models need a serialized body *and* the matching boundary in
 * `content-type`; `FormData` exposes neither, so it is wrapped in a `Response`
 * to make the runtime serialize it.
 */
export async function runWorkersAIImage(
  env: Env,
  spec: ImageModelSpec,
  request: ImageRequest,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const ai = env.AI;
  if (!ai) {
    throw new ProviderError(
      "服务端没有绑定 Workers AI，请改用自带密钥的图像提供商。",
      500,
      "ai_binding_missing",
    );
  }

  let input: unknown;
  if (spec.input === "multipart") {
    const form = buildForm(request, spec);
    const serialized = new Response(form);
    input = {
      multipart: {
        body: serialized.body,
        contentType: serialized.headers.get("content-type") ?? "multipart/form-data",
      },
    };
  } else {
    input = buildJson(request, spec);
  }

  let result: unknown;
  try {
    result = await ai.run(spec.id as never, input as never, { signal } as never);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("已取消。", 499, "aborted");
    }
    throw new ProviderError(
      `Workers AI 图像生成失败：${errorMessage(error)}`,
      502,
      "ai_image_failed",
    );
  }

  const image = await extractImage(result);
  if (!image) {
    throw new ProviderError(
      "模型没有返回图片（可能触发了内容审核，或该模型暂不可用）。",
      502,
      "empty_image",
    );
  }
  return image;
}
