import type { ImageModelSpec } from "../../shared/images";
import { ProviderError, truncate } from "../types";
import {
  readImageSize,
  sniffMime,
  type GeneratedImage,
  type ImageRequest,
} from "./workers-ai-image";

export interface CompatImageInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  spec: ImageModelSpec;
  request: ImageRequest;
}

function endpoint(baseUrl: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("images/generations", base);
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `上游返回 ${response.status}`;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    // tokenrhythm answers `{ code, message, traceId }`; OpenAI answers
    // `{ error: { message } }`. Both are worth surfacing verbatim.
    if (typeof payload.message === "string") return truncate(payload.message);
    const error = payload.error as Record<string, unknown> | string | undefined;
    if (typeof error === "string") return truncate(error);
    if (error && typeof error.message === "string") return truncate(error.message);
  } catch {
    // Fall through to the raw body.
  }
  return truncate(text);
}

/**
 * Calls an OpenAI-compatible `/images/generations` endpoint.
 *
 * `b64_json` is requested explicitly: tokenrhythm otherwise returns a signed
 * OSS URL that expires in about an hour, which would leave broken images in the
 * browser a day later.
 */
export async function runCompatImage(
  input: CompatImageInput,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const { spec, request } = input;
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: request.prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (spec.sizeControl) body.size = `${request.width}x${request.height}`;
  if (spec.negativePrompt && request.negativePrompt) {
    body.negative_prompt = request.negativePrompt;
  }
  if (request.seed !== undefined) body.seed = request.seed;

  let response: Response;
  try {
    response = await fetch(endpoint(input.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("已取消。", 499, "aborted");
    }
    throw new ProviderError(
      `图像接口请求失败：${error instanceof Error ? error.message : String(error)}`,
      502,
      "upstream_unreachable",
    );
  }

  if (!response.ok) {
    const detail = await readError(response);
    throw new ProviderError(detail, response.status, "upstream_error");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError("上游返回的不是 JSON。", 502, "bad_upstream_response");
  }

  const record = payload as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  const first = data[0] as Record<string, unknown> | undefined;
  const base64 = typeof first?.b64_json === "string" ? first.b64_json : "";
  if (!base64) {
    const url = typeof first?.url === "string" ? first.url : "";
    throw new ProviderError(
      url
        ? "上游只返回了临时链接，没有返回图片数据。"
        : "上游没有返回图片（可能触发了内容审核）。",
      502,
      "empty_image",
    );
  }

  // Read the real size from the header: the endpoint may ignore `size`.
  const head = base64.slice(0, 4096);
  const binary = atob(head);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const size = readImageSize(bytes);

  return {
    base64,
    mimeType: sniffMime(base64),
    ...(size ? { width: size.width, height: size.height } : {}),
  };
}
