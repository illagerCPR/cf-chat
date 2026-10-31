import type { ChatMessage, ThinkingMode } from "../../shared/models";
import { ProviderError, errorMessage, type Delta, type Env } from "../types";

export interface WorkersAIInput {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  thinking: ThinkingMode;
}

const EVENT_SEPARATOR = /\r?\n\r?\n/;

/** Model families that read `chat_template_kwargs.enable_thinking`. */
const THINKING_FAMILIES = ["qwen3", "gemma-4", "glm-4", "nemotron"];

interface Piece {
  kind: "content" | "reasoning";
  text: string;
}

function thinkingKwargs(
  model: string,
  mode: ThinkingMode,
): Record<string, unknown> | undefined {
  if (mode === "auto") return undefined;
  const id = model.toLowerCase();
  if (!THINKING_FAMILIES.some((family) => id.includes(family))) return undefined;
  return { enable_thinking: mode === "on" };
}

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

function addPiece(out: Piece[], kind: Piece["kind"], value: unknown): void {
  if (typeof value === "string" && value) out.push({ kind, text: value });
}

/**
 * Extracts text from the various shapes a Workers AI chunk can take.
 *
 * Reasoning models (Qwen3, Kimi, DeepSeek on other providers) return their
 * chain of thought beside the answer, usually as `reasoning_content` and
 * sometimes as `reasoning`. Both are kept separate from the answer text.
 */
function piecesOf(chunk: unknown): Piece[] {
  if (typeof chunk === "string") {
    return chunk ? [{ kind: "content", text: chunk }] : [];
  }
  if (!chunk || typeof chunk !== "object") return [];

  const out: Piece[] = [];
  const record = chunk as Record<string, unknown>;

  // Native prompt-style response: one text field, no choices.
  if (typeof record.response === "string" && record.response) {
    return [{ kind: "content", text: record.response }];
  }

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const message = choice?.message as Record<string, unknown> | undefined;

    // A streamed chunk carries either a delta or a full message, never both.
    // Reading both would duplicate every token.
    if (delta) {
      addPiece(out, "reasoning", delta.reasoning_content ?? delta.reasoning);
      addPiece(out, "content", delta.content);
      return out;
    }
    if (message) {
      addPiece(out, "reasoning", message.reasoning_content ?? message.reasoning);
      addPiece(out, "content", message.content);
      return out;
    }
    addPiece(out, "content", choice?.text);
    return out;
  }

  addPiece(out, "content", record.text);
  return out;
}

/** Turns one `data:` payload of a Workers AI SSE frame into text pieces. */
function piecesFromEvent(raw: string): Piece[] {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") return [];
  try {
    return piecesOf(JSON.parse(data));
  } catch {
    // Not JSON: the model streamed plain text rather than SSE frames.
    return [{ kind: "content", text: data }];
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
 * Normalizes any Workers AI streaming shape into content/reasoning pieces.
 *
 * The binding has shipped three shapes over time: an async iterable of
 * `{ response }` objects, a `ReadableStream` of SSE bytes, and plain text
 * chunks. All three converge here, and SSE is auto-detected instead of assumed.
 * Getting this wrong silently produces an empty reply, which is exactly the
 * failure mode this function exists to avoid.
 */
async function* readChunks(source: AsyncIterable<unknown>): AsyncGenerator<Piece> {
  const decoder = new TextDecoder();
  let buffer = "";
  let sse: boolean | null = null;

  for await (const chunk of source) {
    if (typeof chunk === "string") {
      buffer += chunk;
    } else if (chunk instanceof Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
    } else {
      for (const piece of piecesOf(chunk)) yield piece;
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
        for (const piece of piecesFromEvent(raw)) yield piece;
        match = EVENT_SEPARATOR.exec(buffer);
      }
    } else if (sse === false && buffer) {
      const text = buffer;
      buffer = "";
      yield { kind: "content", text };
    }
  }

  if (buffer.trim()) {
    // `sse === null` means the stream was too short to detect framing, so the
    // leftover has to be treated as plain text rather than parsed as SSE.
    if (sse === true) {
      for (const piece of piecesFromEvent(buffer)) yield piece;
    } else {
      yield { kind: "content", text: buffer };
    }
  }
}

/** Streams text out of whatever `ai.run` handed back. */
async function* normalize(result: unknown): AsyncGenerator<Piece> {
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

  for (const piece of piecesOf(result)) yield piece;
}

/**
 * Runs a Workers AI model. The `-lora` catalog entries are older prompt-style
 * models while most current models take `messages`, so both input shapes are
 * attempted. An attempt that produces no answer text counts as a failure and
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

  const shared: Record<string, unknown> = {
    stream: true,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
  };
  const kwargs = thinkingKwargs(input.model, input.thinking);
  const payloads: Array<Record<string, unknown>> = [];
  const messagesPayload: Record<string, unknown> = { ...shared, messages: input.messages };
  if (kwargs) messagesPayload.chat_template_kwargs = kwargs;
  payloads.push(messagesPayload);
  payloads.push({ ...shared, prompt: toGemmaPrompt(input.messages) });

  let lastError: unknown = new Error("没有返回任何内容");

  for (const payload of payloads) {
    if (signal.aborted) return;

    let attemptContent = false;
    let attemptReasoning = false;
    try {
      const result = await ai.run(input.model, payload as never, { signal } as never);
      for await (const piece of normalize(result)) {
        if (piece.kind === "content") attemptContent = true;
        else attemptReasoning = true;
        yield { type: piece.kind, value: piece.text };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (signal.aborted) return;
      if (attemptContent) {
        // Retrying now would duplicate text the visitor already saw.
        throw new ProviderError(
          `Workers AI 流式中断：${errorMessage(error)}`,
          502,
          "ai_stream_failed",
        );
      }
      if (attemptReasoning) {
        // The caller resets the browser before retrying with the fallback model.
        throw new ProviderError(
          `Workers AI 思考中断：${errorMessage(error)}`,
          502,
          "ai_stream_failed",
          true,
        );
      }
      lastError = error;
      continue;
    }

    if (attemptContent) return;
    if (attemptReasoning) {
      throw new ProviderError(
        "模型只生成了思考内容，没有正文（可能已达到最大 tokens）。",
        502,
        "thinking_only",
        true,
      );
    }
    lastError = new Error("模型没有返回任何内容");
  }

  throw new ProviderError(
    `Workers AI 调用失败：${errorMessage(lastError)}`,
    502,
    "ai_call_failed",
    // Only retry with the fallback model if the request itself never worked.
    true,
  );
}
