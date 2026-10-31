import type { ChatMessage, ThinkingMode } from "../../shared/models";
import { estimatedUsage, estimatePromptTokens, providerUsage } from "../../shared/tokens";
import type { Usage } from "../../shared/tokens";
import { ProviderError, truncate, type Delta } from "../types";

export interface CompatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  thinking: ThinkingMode;
}

const EVENT_SEPARATOR = /\r?\n\r?\n/;

function endpoint(baseUrl: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", base);
}

interface ParsedEvent {
  done: boolean;
  content?: string;
  reasoning?: string;
  /** Exact accounting, only present on the final chunk of most providers. */
  usage?: Usage;
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
    const usage = providerUsage(payload.usage) ?? undefined;
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    // Usage arrives on its own chunk (`choices: []`) for OpenAI-style streams.
    if (!choice) return { done: false, usage };
    const delta = choice.delta as Record<string, unknown> | undefined;
    const message = choice.message as Record<string, unknown> | undefined;
    const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? message?.reasoning_content ?? message?.reasoning;
    const content = delta?.content ?? message?.content;
    return {
      done: false,
      usage,
      reasoning: typeof reasoning === "string" ? reasoning : "",
      content: typeof content === "string" ? content : "",
    };
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

/** DeepSeek toggles thinking with a top-level `thinking` object. */
export function isDeepSeek(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("deepseek.com");
  } catch {
    return false;
  }
}

function requestBody(input: CompatInput, includeUsage: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    stream: true,
  };
  // Open-style APIs only report usage when asked; providers that reject the
  // field are retried once below without it.
  if (includeUsage) body.stream_options = { include_usage: true };
  if (input.thinking !== "auto" && isDeepSeek(input.baseUrl)) {
    body.thinking = { type: input.thinking === "on" ? "enabled" : "disabled" };
  }
  return body;
}

function send(input: CompatInput, signal: AbortSignal, includeUsage: boolean): Promise<Response> {
  return fetch(endpoint(input.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(requestBody(input, includeUsage)),
    signal,
  });
}

/** Streams an OpenAI-compatible chat completion, re-emitting deltas verbatim. */
export async function* runOpenAICompatible(
  input: CompatInput,
  signal: AbortSignal,
): AsyncGenerator<Delta> {
  let response = await send(input, signal, true);
  if (!response.ok && (response.status === 400 || response.status === 422)) {
    // A strict server may reject `stream_options` outright; the conversation is
    // still worth having without token accounting, so retry once without it.
    await readError(response);
    response = await send(input, signal, false);
  }
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
  let contentEmitted = false;
  let reasoningEmitted = false;
  let finished = false;
  let usage: Usage | null = null;
  let output = "";

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
        if (event.done) {
          finished = true;
          buffer = "";
          break;
        }
        if (event.error) throw new ProviderError(event.error, 502, "upstream_error");
        if (event.usage) usage = event.usage;
        if (event.reasoning) {
          reasoningEmitted = true;
          output += event.reasoning;
          yield { type: "reasoning", value: event.reasoning };
        }
        if (event.content) {
          contentEmitted = true;
          output += event.content;
          yield { type: "content", value: event.content };
        }

        match = EVENT_SEPARATOR.exec(buffer);
      }
      if (finished) break;
    }

    if (!finished) {
      const tail = parseEvent(buffer);
      if (tail.usage) usage = tail.usage;
      if (tail.reasoning) {
        reasoningEmitted = true;
        output += tail.reasoning;
        yield { type: "reasoning", value: tail.reasoning };
      }
      if (tail.content) {
        contentEmitted = true;
        output += tail.content;
        yield { type: "content", value: tail.content };
      }
      if (tail.error) throw new ProviderError(tail.error, 502, "upstream_error");
    }
    if (reasoningEmitted && !contentEmitted) {
      throw new ProviderError(
        "模型只生成了思考内容，没有正文（可能已达到最大 tokens）。",
        502,
        "thinking_only",
      );
    }

    yield {
      type: "usage",
      value: usage ?? estimatedUsage(estimatePromptTokens(input.messages), output),
    };
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
