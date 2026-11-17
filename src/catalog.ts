import {
  IMAGE_PRESETS,
  IMAGE_RATIOS,
  WORKERS_AI_IMAGE_MODELS,
} from "../shared/images";
import { COMPAT_PRESETS, WORKERS_AI_MODELS } from "../shared/models";
import { json } from "./http";
import type { Env } from "./types";

/** Tells the browser which backends are usable, so the UI can hide dead options. */
export async function handleCatalog(env: Env): Promise<Response> {
  return json({
    workersAI: {
      configured: Boolean(env.AI),
      defaultModel: env.DEFAULT_MODEL ?? "@cf/qwen/qwen3.8-27b",
      fallbackModel: env.FALLBACK_MODEL ?? null,
      models: WORKERS_AI_MODELS,
    },
    compatPresets: COMPAT_PRESETS,
    mock: env.MOCK_AI === "true",
    serverKey: Boolean(env.OPENAI_COMPAT_API_KEY),
    images: {
      configured: Boolean(env.AI),
      defaultModel: env.IMAGE_MODEL ?? WORKERS_AI_IMAGE_MODELS[0].id,
      models: WORKERS_AI_IMAGE_MODELS,
      presets: IMAGE_PRESETS,
      ratios: IMAGE_RATIOS,
      serverKey: Boolean(env.IMAGE_API_KEY),
    },
  });
}
