import type { ChatMessage, ThinkingMode } from "../../shared/models";
import type { Delta } from "../types";

const DEMO_REPLY = `这是**本地演示回复**，由 Worker 内置的 mock 提供商生成，不会调用任何模型。

它能验证的部分：

1. SSE 流式输出是否逐字到达页面
2. Markdown 渲染与代码块样式
3. 停止生成、重新生成、多会话切换

\`\`\`ts
// 换成真实模型只需要在设置里选一个提供商
const res = await fetch("/api/chat", {
  method: "POST",
  body: JSON.stringify({ provider: "workers-ai", messages }),
});
\`\`\`

> 配好 Cloudflare 账号后，把 \`MOCK_AI\` 关掉即可切到 Workers AI。`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Offline demo provider. Only reachable when `MOCK_AI` is set, which never
 * happens in a deployed Worker unless someone opts in on purpose.
 */
export async function* runMock(
  messages: ChatMessage[],
  thinking: ThinkingMode = "auto",
): AsyncGenerator<Delta> {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const question = (lastUser?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

  const opener = question
    ? `你刚刚问的是「${question}」。\n\n`
    : "还没有收到问题。\n\n";

  const text = opener + DEMO_REPLY;

  if (thinking !== "off") {
    const reasoning =
      "（演示）先梳理一下要验证的点：流式通道是否把思考内容与正文分开、折叠面板是否自动展开与收起、停止生成后是否保留已生成的部分。然后再组织正式回复。";
    for (let index = 0; index < reasoning.length; index += 4) {
      await sleep(10);
      yield { type: "reasoning", value: reasoning.slice(index, index + 4) };
    }
  }

  for (let index = 0; index < text.length; index += 3) {
    await sleep(14);
    yield { type: "content", value: text.slice(index, index + 3) };
  }
}
