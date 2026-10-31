import type { ChatMessage, CompatPreset, ProviderKind } from "../../shared/models";

export interface ChatRequestBody {
  provider: ProviderKind;
  presetId?: string;
  baseUrl?: string;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export type StreamEvent =
  | { type: "meta"; data: Record<string, unknown> }
  | { type: "delta"; text: string }
  | { type: "error"; message: string };

export class ChatError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.status = status;
  }
}

export interface Catalog {
  workersAI: {
    configured: boolean;
    defaultModel: string;
    fallbackModel: string | null;
    models: Array<{ id: string; label: string; note: string }>;
  };
  compatPresets: CompatPreset[];
  mock: boolean;
  serverKey: boolean;
}

const EVENT_SEPARATOR = /\r?\n\r?\n/;

type ParsedEvent = StreamEvent | "done" | null;

function parseEvent(raw: string): ParsedEvent {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data) return null;
  if (data === "[DONE]") return "done";

  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    const meta = payload["cf-chat"];
    if (meta && typeof meta === "object") {
      return { type: "meta", data: meta as Record<string, unknown> };
    }
    const error = payload.error as { message?: unknown } | undefined;
    if (error) {
      return { type: "error", message: String(error.message ?? "上游返回错误") };
    }
    const choices = payload.choices as Array<{ delta?: { content?: unknown } }> | undefined;
    const text = choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) return { type: "delta", text };
    return null;
  } catch {
    return null;
  }
}

async function errorFromResponse(response: Response): Promise<ChatError> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: { message?: string; code?: string } };
    return new ChatError(
      payload.error?.message ?? `请求失败（HTTP ${response.status}）`,
      payload.error?.code,
      response.status,
    );
  } catch {
    return new ChatError(
      text.trim() || `请求失败（HTTP ${response.status}）`,
      undefined,
      response.status,
    );
  }
}

export async function* streamChat(
  body: ChatRequestBody,
  apiKey: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-provider-key"] = apiKey;

  const response = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) throw new ChatError("当前浏览器不支持流式响应。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match = EVENT_SEPARATOR.exec(buffer);
      while (match) {
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        const event = parseEvent(rawEvent);
        if (event === "done") return;
        if (event) yield event;

        match = EVENT_SEPARATOR.exec(buffer);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export async function fetchCatalog(): Promise<Catalog | null> {
  try {
    const response = await fetch("/api/catalog", { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()) as Catalog;
  } catch {
    return null;
  }
}
