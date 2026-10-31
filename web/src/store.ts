import type { ProviderKind } from "../../shared/models";
import type { ChatMessage } from "../../shared/models";
import { newId } from "./util";

export interface MessageMeta {
  model: string;
  provider: string;
  fallback?: boolean;
  reason?: string;
}

export interface MessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  meta?: MessageMeta;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: MessageRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  provider: ProviderKind;
  /** Empty string means "use the server default". */
  workersModel: string;
  presetId: string;
  compatModel: string;
  customBaseUrl: string;
  keys: Record<string, string>;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

const SETTINGS_KEY = "cf-chat:settings:v1";
const CONVERSATIONS_KEY = "conversations";

export function defaultSettings(): Settings {
  return {
    provider: "workers-ai",
    workersModel: "",
    presetId: "deepseek",
    compatModel: "deepseek-chat",
    customBaseUrl: "",
    keys: {},
    temperature: 0.7,
    maxTokens: 1024,
    systemPrompt: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!isRecord(raw)) return base;

  const provider = raw.provider;
  const keys = isRecord(raw.keys) ? (raw.keys as Record<string, string>) : base.keys;

  return {
    provider:
      provider === "workers-ai" || provider === "openai-compatible" || provider === "mock"
        ? provider
        : base.provider,
    workersModel: typeof raw.workersModel === "string" ? raw.workersModel : base.workersModel,
    presetId: typeof raw.presetId === "string" ? raw.presetId : base.presetId,
    compatModel: typeof raw.compatModel === "string" ? raw.compatModel : base.compatModel,
    customBaseUrl: typeof raw.customBaseUrl === "string" ? raw.customBaseUrl : base.customBaseUrl,
    keys,
    temperature: typeof raw.temperature === "number" ? raw.temperature : base.temperature,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : base.maxTokens,
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : base.systemPrompt,
  };
}

export function loadSettings(): { settings: Settings; persisted: boolean } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { settings: defaultSettings(), persisted: false };
    return { settings: normalizeSettings(JSON.parse(raw)), persisted: true };
  } catch {
    return { settings: defaultSettings(), persisted: false };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode with storage disabled: the session still works, it just does not persist.
  }
}

export async function loadConversations(): Promise<Conversation[]> {
  try {
    const { get } = await import("idb-keyval");
    const stored = await get<Conversation[]>(CONVERSATIONS_KEY);
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((item) => item && typeof item.id === "string" && Array.isArray(item.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function saveConversations(conversations: Conversation[]): Promise<void> {
  try {
    const { set } = await import("idb-keyval");
    await set(CONVERSATIONS_KEY, conversations);
  } catch {
    // Storage full or unavailable; keep going without persistence.
  }
}

export function createConversation(): Conversation {
  const now = Date.now();
  return { id: newId(), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}

export function createMessage(
  role: MessageRecord["role"],
  content: string,
  extra: Partial<MessageRecord> = {},
): MessageRecord {
  return { id: newId(), role, content, createdAt: Date.now(), ...extra };
}

export function toApiMessages(
  messages: MessageRecord[],
  systemPrompt: string,
): ChatMessage[] {
  const history = messages.filter((message) => !message.error).slice(-20);
  const result: ChatMessage[] = [];

  if (systemPrompt.trim()) {
    result.push({ role: "system", content: systemPrompt.trim() });
  }
  for (const message of history) {
    if (!message.content.trim()) continue;
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

export type { ProviderKind };
