import { COMPAT_PRESETS, WORKERS_AI_MODELS } from "../shared/models";
import { json } from "./http";
import type { Env } from "./types";

/** Tells the browser which backends are usable, so the UI can hide dead options. */
export async function handleCatalog(env: Env): Promise<Response> {
  return json({
    workersAI: {
      configured: Boolean(env.AI),
      defaultModel: env.DEFAULT_MODEL ?? "@cf/google/gemma-2b-it-lora",
      fallbackModel: env.FALLBACK_MODEL ?? null,
      models: WORKERS_AI_MODELS,
    },
    compatPresets: COMPAT_PRESETS,
    mock: env.MOCK_AI === "true",
    serverKey: Boolean(env.OPENAI_COMPAT_API_KEY),
  });
}
