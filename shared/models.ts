export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type ProviderKind = "workers-ai" | "openai-compatible" | "mock";

export interface CompatPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** Where the visitor can create a key for this provider. */
  keyUrl?: string;
}

/**
 * OpenAI-compatible providers. Only the base URL lives on the server side of the
 * allowlist; the browser may pick one of these ids but never an arbitrary host.
 */
export const COMPAT_PRESETS: CompatPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4.1-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-0905-preview", "moonshot-v1-8k"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash", "glm-4-plus"],
    keyUrl: "https://bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen3-8B", "deepseek-ai/DeepSeek-V3"],
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
    keyUrl: "https://openrouter.ai/keys",
  },
];

export interface WorkersAIModel {
  id: string;
  label: string;
  /** Short hint shown in the settings panel. */
  note: string;
}

/** Curated Workers AI models. Any model id can still be typed in by hand. */
export const WORKERS_AI_MODELS: WorkersAIModel[] = [
  {
    id: "@cf/google/gemma-2b-it-lora",
    label: "Gemma 2B IT (LoRA)",
    note: "默认，Beta 阶段免费；8k 上下文，中文较弱",
  },
  {
    id: "@cf/google/gemma-3-12b-it",
    label: "Gemma 3 12B IT",
    note: "中文与推理明显更好，按神经元计费",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    label: "Llama 3.1 8B",
    note: "响应快，适合日常对话",
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen3 30B A3B",
    note: "MoE 模型，中文表现好",
  },
];

export function findPreset(id: string | undefined): CompatPreset | undefined {
  if (!id) return undefined;
  return COMPAT_PRESETS.find((preset) => preset.id === id);
}
