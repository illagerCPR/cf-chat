/**
 * Text-to-image model catalog shared by the Worker and the browser.
 *
 * The three Workers AI families take different input shapes, which is the main
 * thing this file exists to record:
 *
 * - `flux-1-schnell` takes plain JSON and only accepts `prompt` + `steps`
 *   (`additionalProperties: false`), so the image size is not controllable.
 * - `flux-2-*` take **multipart form data** even for a prompt-only request, and
 *   the binding needs a serialized body plus its boundary.
 * - `leonardo/phoenix-1.0` returns raw JPEG bytes instead of base64 JSON.
 *
 * Getting any of these wrong fails at runtime, not at compile time, so the
 * shape is data here rather than a branch buried in the adapter.
 */

export type ImageProviderKind = "workers-ai" | "openai-compatible" | "mock";

/** How the model wants its request body. */
export type ImageInputShape = "json" | "multipart";

/** How the model hands the picture back. */
export type ImageOutputShape = "base64" | "binary";

export interface ImageRatio {
  id: string;
  label: string;
  width: number;
  height: number;
}

/**
 * Ratios offered in the UI. Every size here sits inside the 256–1920 window the
 * flux-2 models accept, inside phoenix's 0–2048 and lucid-origin's 0–2500, and
 * was verified against the tokenrhythm endpoint (which rejects 512x512 for
 * `wan2.7-image`).
 */
export const IMAGE_RATIOS: ImageRatio[] = [
  { id: "1:1", label: "方形 1:1", width: 1024, height: 1024 },
  { id: "16:9", label: "横版 16:9", width: 1280, height: 720 },
  { id: "9:16", label: "竖版 9:16", width: 720, height: 1280 },
  { id: "4:3", label: "横版 4:3", width: 1024, height: 768 },
  { id: "3:4", label: "竖版 3:4", width: 768, height: 1024 },
];

export const DEFAULT_IMAGE_RATIO = "1:1";

export function findRatio(id: string | undefined): ImageRatio {
  return IMAGE_RATIOS.find((ratio) => ratio.id === id) ?? IMAGE_RATIOS[0];
}

export interface ImageModelSpec {
  id: string;
  label: string;
  note: string;
  provider: ImageProviderKind;
  input: ImageInputShape;
  output: ImageOutputShape;
  /** False when the model ignores width/height (flux-1-schnell). */
  sizeControl: boolean;
  /** Smallest and largest edge the model accepts, in pixels. */
  minEdge: number;
  maxEdge: number;
  /** Adjustable diffusion steps, when the model exposes them. */
  steps?: { min: number; max: number; default: number };
  /** Guidance scale, when the model exposes it. */
  guidance?: { min: number; max: number; default: number };
  /** Whether a negative prompt is accepted. */
  negativePrompt?: boolean;
  /** Rough neurons burned per image at 1024x1024, for the cost hint. */
  neuronsPerImage: number;
}

/**
 * Workers AI image models.
 *
 * `neuronsPerImage` comes from the published price table and is only a rough
 * guide: flux-1-schnell bills per 512x512 tile plus per step, the flux-2 models
 * bill per tile, and the Leonardo models bill per tile plus per step.
 */
export const WORKERS_AI_IMAGE_MODELS: ImageModelSpec[] = [
  {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 klein 9B",
    note: "默认。质量最好，4 步固定推理；约 1364 neurons/张，免费额度约 7 张/天",
    provider: "workers-ai",
    input: "multipart",
    output: "base64",
    sizeControl: true,
    minEdge: 256,
    maxEdge: 1920,
    guidance: { min: 1, max: 10, default: 3.5 },
    neuronsPerImage: 1363.64,
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 klein 4B",
    note: "9B 的轻量版，质量接近、便宜一个数量级；约 104 neurons/张",
    provider: "workers-ai",
    input: "multipart",
    output: "base64",
    sizeControl: true,
    minEdge: 256,
    maxEdge: 1920,
    guidance: { min: 1, max: 10, default: 3.5 },
    neuronsPerImage: 104.2,
  },
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 dev",
    note: "细节最丰富，步数可调；按步计费，1024 见方约 3750 neurons/张",
    provider: "workers-ai",
    input: "multipart",
    output: "base64",
    sizeControl: true,
    minEdge: 256,
    maxEdge: 1920,
    steps: { min: 1, max: 50, default: 25 },
    guidance: { min: 1, max: 10, default: 3.5 },
    neuronsPerImage: 3750,
  },
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 schnell",
    note: "最快最省，约 58 neurons/张；尺寸固定，只接受提示词与步数",
    provider: "workers-ai",
    input: "json",
    output: "base64",
    sizeControl: false,
    minEdge: 256,
    maxEdge: 1920,
    steps: { min: 1, max: 8, default: 4 },
    neuronsPerImage: 57.6,
  },
  {
    id: "@cf/leonardo/phoenix-1.0",
    label: "Leonardo Phoenix 1.0",
    note: "插画与艺术风格突出，支持负面提示词；约 2370 neurons/张",
    provider: "workers-ai",
    input: "json",
    output: "binary",
    sizeControl: true,
    minEdge: 256,
    maxEdge: 2048,
    steps: { min: 1, max: 50, default: 25 },
    guidance: { min: 2, max: 10, default: 2 },
    negativePrompt: true,
    neuronsPerImage: 2370,
  },
  {
    id: "@cf/leonardo/lucid-origin",
    label: "Leonardo Lucid Origin",
    note: "创意探索向，风格更放得开；约 2544 neurons/张",
    provider: "workers-ai",
    input: "json",
    output: "base64",
    sizeControl: true,
    minEdge: 256,
    maxEdge: 2500,
    steps: { min: 1, max: 40, default: 25 },
    guidance: { min: 0, max: 10, default: 4.5 },
    neuronsPerImage: 2544,
  },
];

export interface ImagePreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  keyUrl?: string;
  note: string;
}

/**
 * OpenAI-compatible image endpoints. Only the base URL lives server-side; the
 * browser may pick one of these ids but never an arbitrary host.
 *
 * tokenrhythm's `url` responses are signed OSS links that expire in about an
 * hour, so the adapter always asks for `b64_json` and never stores the URL.
 */
export const IMAGE_PRESETS: ImagePreset[] = [
  {
    id: "tokenrhythm",
    label: "基元律动 tokenrhythm",
    baseUrl: "https://tokenrhythm.studio/v1",
    models: ["qwen-image-2.0", "wan2.7-image"],
    keyUrl: "https://tokenrhythm.studio",
    note: "国内直连，按张计费（约 ¥0.2/张）；wan2.7-image 不支持 512 见方",
  },
];

export function findImagePreset(id: string | undefined): ImagePreset | undefined {
  if (!id) return undefined;
  return IMAGE_PRESETS.find((preset) => preset.id === id);
}

export function findImageModel(id: string | undefined): ImageModelSpec | undefined {
  if (!id) return undefined;
  return WORKERS_AI_IMAGE_MODELS.find((model) => model.id === id);
}

/** Clamps a requested size into what the model actually accepts. */
export function clampSize(
  spec: ImageModelSpec,
  ratio: ImageRatio,
): { width: number; height: number } {
  const clamp = (value: number): number =>
    Math.min(spec.maxEdge, Math.max(spec.minEdge, Math.round(value)));
  return { width: clamp(ratio.width), height: clamp(ratio.height) };
}

/**
 * Rough neuron cost for one image. Mirrors the published price table closely
 * enough to warn before a request, not to bill anyone.
 */
export function estimateNeurons(
  spec: ImageModelSpec,
  width: number,
  height: number,
  steps: number,
): number {
  const tiles = Math.max(1, Math.ceil((width * height) / (512 * 512)));
  const megapixels = (width * height) / (1024 * 1024);

  switch (spec.id) {
    case "@cf/black-forest-labs/flux-1-schnell":
      return tiles * 4.8 + steps * 9.6;
    case "@cf/black-forest-labs/flux-2-klein-4b":
      return tiles * 26.05;
    case "@cf/black-forest-labs/flux-2-klein-9b":
      return 1363.64 + Math.max(0, megapixels - 1) * 181.82;
    case "@cf/black-forest-labs/flux-2-dev":
      return tiles * 37.5 * steps;
    case "@cf/leonardo/phoenix-1.0":
      return tiles * 530 + steps * 10;
    case "@cf/leonardo/lucid-origin":
      return tiles * 636 + steps * 12;
    default:
      return spec.neuronsPerImage;
  }
}

/** Free Workers AI allowance per day, in neurons. */
export const DAILY_NEURON_BUDGET = 10_000;

export const MAX_IMAGE_COUNT = 4;
export const MAX_PROMPT_CHARS = 2000;
