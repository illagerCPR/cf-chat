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
  /** Real pixel size read from the bytes; null when the format is unknown. */
  width?: number;
  height?: number;
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

/**
 * Reads the real pixel size out of the encoded bytes.
 *
 * The requested width/height is only a hint: `flux-1-schnell` ignores it
 * entirely and always answers 1024x1024, so reporting the requested size would
 * make the browser reserve the wrong aspect ratio and letterbox the picture.
 * Returns null when the format is not recognised, and the caller then falls
 * back to what it asked for.
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: 8-byte signature, then an IHDR chunk with width/height as big-endian u32.
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: "GIF87a"/"GIF89a", then little-endian u16 width/height.
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP: RIFF container; VP8X stores canvas size minus one as 24-bit LE.
  if (
    bytes.length > 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width, height };
    }
    if (chunk === "VP8 ") {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      return { width, height };
    }
    if (chunk === "VP8L") {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  // JPEG: walk the segment chain until a start-of-frame marker.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0..SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return { width, height };
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2) return null;
      offset += 2 + length;
    }
  }

  return null;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

function fromBytes(bytes: Uint8Array, declaredType?: string): GeneratedImage | null {
  if (!bytes.length) return null;
  const base64 = toBase64(bytes);
  const size = readImageSize(bytes);
  return {
    base64,
    mimeType: declaredType || sniffMime(base64),
    ...(size ? { width: size.width, height: size.height } : {}),
  };
}

async function readBinary(value: unknown): Promise<GeneratedImage | null> {
  if (value instanceof ArrayBuffer) return fromBytes(new Uint8Array(value));
  if (value instanceof Uint8Array) return fromBytes(value);
  if (value instanceof Blob) {
    return fromBytes(new Uint8Array(await value.arrayBuffer()), value.type);
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
      return fromBytes(merged);
    }

    const image = record.image;
    if (typeof image === "string" && image) {
      // Some models prefix the payload with a data URL.
      const comma = image.startsWith("data:") ? image.indexOf(",") : -1;
      const base64 = comma >= 0 ? image.slice(comma + 1) : image;
      const declared = comma >= 0 ? image.slice(5, comma).split(";")[0] : "";
      // Decode just enough to read the header; the payload itself stays base64.
      const size = readImageSize(base64ToBytes(base64.slice(0, 4096)));
      return {
        base64,
        mimeType: declared || sniffMime(base64),
        ...(size ? { width: size.width, height: size.height } : {}),
      };
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
