import type { ChatMessage } from "../../shared/models";
import { ProviderError, errorMessage, type Delta, type Env } from "../types";

export interface WorkersAIInput {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
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
  }
  return "";
}

interface RunOptions {
  signal?: AbortSignal;
}

/**
 * Runs a Workers AI model. The `-lora` catalog entries are older prompt-style
 * models while most current models take `messages`, so both input shapes are
 * attempted before giving up.
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

  const options: RunOptions = { signal };
  let stream: unknown;
  let lastError: unknown;

  for (const payload of payloads) {
    try {
      stream = await ai.run(input.model, payload as never, options as never);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!stream) {
    throw new ProviderError(
      `Workers AI 调用失败：${errorMessage(lastError)}`,
      502,
      "ai_call_failed",
      true,
    );
  }

  try {
    for await (const chunk of stream as AsyncIterable<unknown>) {
      const text = textOf(chunk);
      if (text) yield { type: "content", value: text };
    }
  } catch (error) {
    throw new ProviderError(
      `Workers AI 流式中断：${errorMessage(error)}`,
      502,
      "ai_stream_failed",
      true,
    );
  }
}
