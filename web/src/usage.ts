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
  /** Replies whose numbers came from the character estimate. */
  estimatedReplies: number;
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
    estimatedReplies: 0,
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
    if (usage.estimated) stats.estimatedReplies += 1;
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

/** Conversation footer, e.g. "本对话 3 轮 · 累计 1,820 tokens · 本轮输入 1,204". */
export function formatConversationUsage(stats: ConversationUsage): string {
  const allEstimated = stats.estimatedReplies === stats.replies;
  const mixed = stats.estimatedReplies > 0 && !allEstimated;
  const approx = allEstimated ? "≈ " : "";
  const suffix = mixed ? " · 含估算" : "";
  return `${approx}本对话 ${stats.replies} 轮 · 累计 ${formatTokens(
    stats.totalTokens,
  )} tokens · 本轮输入 ${formatTokens(stats.contextTokens)}${suffix}`;
}
