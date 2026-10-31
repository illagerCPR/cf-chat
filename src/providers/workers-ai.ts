import type { ChatMessage } from "../../shared/models";
import { ProviderError, errorMessage, type Delta, type Env } from "../types";

export interface WorkersAIInput {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
}

const EVENT_SEPARATOR = /\r?\n\r?\n/;

/** Gemma 2 has no system role, so a system prompt is folded into the first user turn. */
function toGemmaPrompt(messages: ChatMessage[]): string {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  const turns: string[] = [];
  let systemAttached = false;

  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    let content = message.content;
    if (!systemAttached && system) {
      content = `${system}\n\n${content}`;
      systemAttached = true;
    }
    turns.push(`<start_of_turn>${role}\n${content}<end_of_turn>`);
  }

  if (system && !systemAttached) {
    turns.unshift(`<start_of_turn>user\n${system}<end_of_turn>`);
  }

  turns.push("<start_of_turn>model");
  return turns.join("\n");
}

/** Extracts text from the various shapes a Workers AI chunk can take. */
function textOf(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (!chunk || typeof chunk !== "object") return "";
  const record = chunk as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string") return delta.content;
    const message = choice?.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
    if (typeof choice?.text === "string") return choice.text;
  }
  if (typeof record.text === "string") return record.text;
  return "";
}

/** Turns one `data:` payload of a Workers AI SSE frame into text. */
function textFromEvent(raw: string): string {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") return "";
  try {
    return textOf(JSON.parse(data));
  } catch {
    // Not JSON: the model streamed plain text rather than SSE frames.
    return data;
  }
}

function asStream(value: unknown): ReadableStream<Uint8Array> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { getReader?: unknown; body?: unknown; stream?: unknown };
  if (typeof candidate.getReader === "function") return value as ReadableStream<Uint8Array>;

  for (const nested of [candidate.body, candidate.stream]) {
    if (nested && typeof (nested as { getReader?: unknown }).getReader === "function") {
      return nested as ReadableStream<Uint8Array>;
    }
  }
  return null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || typeof value !== "object") return false;
  return typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

async function* readStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/**
 * Normalizes any Workers AI streaming shape into text chunks.
 *
 * The binding has shipped three shapes over time: an async iterable of
 * `{ response }` objects, a `ReadableStream` of SSE bytes, and plain text
 * chunks. All three converge here, and SSE is auto-detected instead of assumed.
 * Getting this wrong silently produces an empty reply, which is exactly the
 * failure mode this function exists to avoid.
 */
async function* readChunks(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let sse: boolean | null = null;

  for await (const chunk of source) {
    if (typeof chunk === "string") {
      buffer += chunk;
    } else if (chunk instanceof Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
    } else {
      const text = textOf(chunk);
      if (text) yield text;
      continue;
    }

    if (sse === null && (buffer.includes("\n") || buffer.length > 64)) {
      sse = buffer.includes("data:");
    }

    if (sse === true) {
      let match = EVENT_SEPARATOR.exec(buffer);
      while (match) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const text = textFromEvent(raw);
        if (text) yield text;
        match = EVENT_SEPARATOR.exec(buffer);
      }
    } else if (sse === false && buffer) {
      const text = buffer;
      buffer = "";
      yield text;
    }
  }

  if (buffer.trim()) {
    // `sse === null` means the stream was too short to detect framing, so the
    // leftover has to be treated as plain text rather than parsed as SSE.
    const text = sse === true ? textFromEvent(buffer) : buffer;
    if (text) yield text;
  }
}

/** Streams text out of whatever `ai.run` handed back. */
async function* normalize(result: unknown): AsyncGenerator<string> {
  if (result === null || result === undefined) return;

  const stream = asStream(result);
  if (stream) {
    yield* readChunks(readStream(stream));
    return;
  }

  if (isAsyncIterable(result)) {
    yield* readChunks(result);
    return;
  }

  const text = textOf(result);
  if (text) yield text;
}

/**
 * Runs a Workers AI model. The `-lora` catalog entries are older prompt-style
 * models while most current models take `messages`, so both input shapes are
 * attempted. An attempt that produces no text at all counts as a failure and
 * moves on, because a 200 with an empty stream is not a usable answer.
 */
export async function* runWorkersAI(
  env: Env,
  input: WorkersAIInput,
  signal: AbortSignal,
): AsyncGenerator<Delta> {
  const ai = env.AI;
  if (!ai) {
    throw new ProviderError(
      "服务端没有绑定 Workers AI，请改用自带密钥的提供商。",
      500,
      "ai_binding_missing",
    );
  }

  const shared = { stream: true, max_tokens: input.maxTokens, temperature: input.temperature };
  const payloads: Array<Record<string, unknown>> = [
    { ...shared, messages: input.messages },
    { ...shared, prompt: toGemmaPrompt(input.messages) },
  ];

  let lastError: unknown = new Error("没有返回任何内容");
  let produced = false;

  for (const payload of payloads) {
    if (signal.aborted) return;

    let attemptProduced = false;
    try {
      const result = await ai.run(input.model, payload as never, { signal } as never);
      for await (const text of normalize(result)) {
        attemptProduced = true;
        produced = true;
        yield { type: "content", value: text };
      }
      if (attemptProduced) return;
      lastError = new Error("模型没有返回任何内容");
    } catch (error) {
      if (attemptProduced) {
        // Retrying now would duplicate text the visitor already saw.
        throw new ProviderError(
          `Workers AI 流式中断：${errorMessage(error)}`,
          502,
          "ai_stream_failed",
        );
      }
      if (error instanceof Error && error.name === "AbortError") return;
      lastError = error;
    }
  }

  throw new ProviderError(
    `Workers AI 调用失败：${errorMessage(lastError)}`,
    502,
    "ai_call_failed",
    // Only retry with the fallback model if the request itself never worked.
    !produced,
  );
}
