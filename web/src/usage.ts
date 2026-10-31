import { estimatePromptTokens, estimateTextTokens, formatTokens } from "../../shared/tokens";
import type { Usage } from "../../shared/tokens";
import { toApiMessages, type Conversation, type MessageRecord } from "./store";

/**
 * Usage for one assistant reply: what the Worker reported, or an estimate for
 * replies saved before usage tracking existed (and for interrupted streams).
 */
export function usageForMessage(
  message: MessageRecord,
  history: MessageRecord[],
  systemPrompt: string,
): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.usage) return message.usage;

  const completionTokens =
    estimateTextTokens(message.content) + estimateTextTokens(message.reasoning ?? "");
  if (!completionTokens) return undefined;

  const promptTokens = estimatePromptTokens(toApiMessages(history, systemPrompt));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

export interface ConversationUsage {
  replies: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt size of the newest reply, i.e. how large the context has grown. */
  contextTokens: number;
  estimated: boolean;
}

export function conversationUsage(
  conversation: Conversation | undefined,
  systemPrompt: string,
): ConversationUsage | null {
  if (!conversation || conversation.messages.length === 0) return null;

  const stats: ConversationUsage = {
    replies: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    estimated: false,
  };

  conversation.messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const usage = usageForMessage(message, conversation.messages.slice(0, index), systemPrompt);
    if (!usage) return;
    stats.replies += 1;
    stats.promptTokens += usage.promptTokens;
    stats.completionTokens += usage.completionTokens;
    stats.totalTokens += usage.totalTokens;
    stats.contextTokens = usage.promptTokens;
    stats.estimated = stats.estimated || usage.estimated;
  });

  return stats.replies > 0 ? stats : null;
}

/** Short per-reply line, e.g. "输入 128 · 输出 456 · 共 584 tokens". */
export function formatUsageLine(usage: Usage): string {
  const approx = usage.estimated ? "≈ " : "";
  return `${approx}输入 ${formatTokens(usage.promptTokens)} · 输出 ${formatTokens(
    usage.completionTokens,
  )} · 共 ${formatTokens(usage.totalTokens)} tokens`;
}

/** Conversation footer, e.g. "本对话 3 轮 · 累计 1,820 tokens · 上下文 1,204". */
export function formatConversationUsage(stats: ConversationUsage): string {
  const approx = stats.estimated ? "≈ " : "";
  return `${approx}本对话 ${stats.replies} 轮 · 累计 ${formatTokens(
    stats.totalTokens,
  )} tokens · 上下文 ${formatTokens(stats.contextTokens)}`;
}
