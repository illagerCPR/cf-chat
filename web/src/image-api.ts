import type { ImageProviderKind } from "../../shared/images";

export interface ImageRequest {
  provider: ImageProviderKind;
  presetId?: string;
  baseUrl?: string;
  model?: string;
  prompt: string;
  negativePrompt?: string;
  ratio: string;
  count?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  /** Reference images for image-to-image; only the FLUX.2 family takes these. */
  inputImages?: { base64: string; mimeType: string }[];
}

export interface GeneratedImage {
  /** Base64 payload without the `data:` prefix. */
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface ImageResponse {
  images: GeneratedImage[];
  meta: {
    provider: string;
    model: string;
    width: number;
    height: number;
    steps?: number;
    neurons?: number;
  };
}

export class ImageError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "ImageError";
    this.code = code;
    this.status = status;
  }
}

async function errorFromResponse(response: Response): Promise<ImageError> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: { message?: string; code?: string } };
    return new ImageError(
      payload.error?.message ?? `请求失败（HTTP ${response.status}）`,
      payload.error?.code,
      response.status,
    );
  } catch {
    return new ImageError(
      text.trim() || `请求失败（HTTP ${response.status}）`,
      undefined,
      response.status,
    );
  }
}

/**
 * Generates images. Unlike chat this is a single JSON round trip: image models
 * do not stream, and a 1024x1024 PNG is a few hundred kilobytes at most.
 */
export async function generateImages(
  body: ImageRequest,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<ImageResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-provider-key"] = apiKey;

  const response = await fetch("/api/image", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw await errorFromResponse(response);

  const payload = (await response.json()) as ImageResponse;
  if (!Array.isArray(payload.images) || payload.images.length === 0) {
    throw new ImageError("服务端没有返回图片。");
  }
  return payload;
}
