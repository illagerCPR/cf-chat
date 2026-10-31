import type { ChatMessage } from "../../shared/models";
import { ProviderError, truncate, type Delta } from "../types";

export interface CompatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
}

const EVENT_SEPARATOR = /\r?\n\r?\n/;

function endpoint(baseUrl: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", base);
}

interface ParsedEvent {
  done: boolean;
  text?: string;
  error?: string;
}

function parseEvent(raw: string): ParsedEvent {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data) return { done: false };
  if (data === "[DONE]") return { done: true };

  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    const error = payload.error as Record<string, unknown> | string | undefined;
    if (error) {
      const message = typeof error === "string" ? error : String(error.message ?? "上游返回错误");
      return { done: false, error: truncate(message) };
    }
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return { done: false };
    const delta = choice.delta as Record<string, unknown> | undefined;
    const message = choice.message as Record<string, unknown> | undefined;
    const text = delta?.content ?? message?.content;
    return { done: false, text: typeof text === "string" ? text : "" };
  } catch {
    // Keep-alive comments and partial JSON are not interesting.
    return { done: false };
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `上游返回 ${response.status}`;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error as Record<string, unknown> | undefined;
    if (error && typeof error.message === "string") return truncate(error.message);
    if (typeof payload.message === "string") return truncate(payload.message);
  } catch {
    // Fall through to the raw body.
  }
  return truncate(text);
}

/** Streams an OpenAI-compatible chat completion, re-emitting deltas verbatim. */
export async function* runOpenAICompatible(
  input: CompatInput,
  signal: AbortSignal,
): AsyncGenerator<Delta> {
  const response = await fetch(endpoint(input.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await readError(response);
    throw new ProviderError(detail, response.status, "upstream_error");
  }
  if (!response.body) {
    throw new ProviderError("上游没有返回内容流。", 502, "empty_stream");
  }

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
        if (event.done) return;
        if (event.error) throw new ProviderError(event.error, 502, "upstream_error");
        if (event.text) yield { type: "content", value: event.text };

        match = EVENT_SEPARATOR.exec(buffer);
      }
    }

    const tail = parseEvent(buffer);
    if (tail.text) yield { type: "content", value: tail.text };
    if (tail.error) throw new ProviderError(tail.error, 502, "upstream_error");
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
