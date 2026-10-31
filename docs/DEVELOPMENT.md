# 开发说明

面向维护者与二次开发者。用户向的部署与使用说明见 [README](../README.md)。

## 架构

```
浏览器 SPA（Vite 构建，产物由 Worker 的静态资源托管）
  │  POST /api/chat  { provider, model, messages, ... }
  │  header: x-provider-key（BYOK 时携带）
  ▼
单个 Worker（src/index.ts）
  ├─ /api/chat     → 提供商适配器 → 归一化 SSE
  │                   ├─ Workers AI binding（默认，免密钥）
  │                   ├─ OpenAI 兼容 HTTP（预设或自定义 Base URL）
  │                   └─ mock（仅本地，MOCK_AI=true 时可用）
  └─ /api/catalog  → 前端可用的模型/提供商清单
```

设计要点：

1. **浏览器只与自己的 Worker 通信**。第三方密钥经 Worker 转发，避免 CORS 与密钥暴露在跨域请求里。
2. **只有一种流协议**。所有提供商都被归一化成 OpenAI 的 SSE 形状（`choices[0].delta.content`），前端只写一个解析器。额外事件：`{"cf-chat": {...}}` 用于元信息（实际使用的模型、是否降级）。
3. **不缓冲**。上游响应直接 `pipeThrough`/逐块转发，Worker 只是 I/O，不占 CPU（免费版 CPU 上限 10ms/次）。
4. **客户端断开即取消**。前端 `AbortController` → `request.signal` → 上游 `fetch` 取消。

## 目录结构

```
shared/models.ts          提供商预设、Workers AI 模型清单（前后端共用）
src/
  index.ts                路由
  chat.ts                 请求校验、限流、提供商解析、降级逻辑
  catalog.ts              /api/catalog
  sse.ts                  归一化 SSE 输出
  http.ts                 JSON 辅助
  types.ts                Env、Delta、ProviderError
  providers/
    workers-ai.ts         AI binding 适配（messages / Gemma prompt 双格式）
    openai-compatible.ts  OpenAI 兼容 SSE 透传
    mock.ts               本地演示
web/
  index.html              页面骨架
  src/ui.ts               应用控制器（渲染、流式、设置面板）
  src/store.ts            设置与对话持久化
  src/api.ts              SSE 客户端
  src/markdown.ts         marked + DOMPurify
  src/styles.css
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 同时启动 Worker（8787）与 Vite（5173，`/api` 代理到 8787），开启 `MOCK_AI` |
| `pnpm dev:api` | 只启 Worker |
| `pnpm dev:web` | 只启 Vite |
| `pnpm build` | 构建前端到 `dist/client` |
| `pnpm preview` | 构建后用 `wrangler dev` 在 8787 预览完整产物 |
| `pnpm check` | 两套 tsconfig 分别做类型检查（Worker / 前端） |
| `pnpm deploy` | 构建并部署 |

`wrangler dev` 的 AI binding 属于远端绑定：本地调用需要在有 Cloudflare 登录态的环境里运行，否则会报 `Binding AI needs to be run remotely`。没有账号时用默认的 mock 模式即可。

## /api/chat 契约

请求：

```jsonc
{
  "provider": "workers-ai" | "openai-compatible" | "mock",
  "presetId": "deepseek",          // 或 "custom"
  "baseUrl": "https://.../v1",     // 仅 custom 时使用
  "model": "deepseek-chat",
  "messages": [{ "role": "user", "content": "hi" }],
  "temperature": 0.7,
  "maxTokens": 1024
}
```

校验规则：`messages` 1–100 条、单条 ≤20000 字符、合计 ≤120000 字符；`maxTokens` 上限 2048；`provider` 必须命中白名单。

响应：`text/event-stream`，事件体均为 `data: {...}`。

```
data: {"cf-chat":{"provider":"workers-ai","model":"@cf/...","fallback":false}}
data: {"choices":[{"index":0,"delta":{"content":"你"}}]}
data: {"choices":[{"index":0,"delta":{"content":"好"}}]}
data: [DONE]
```

出错（发生在流开始前）返回 JSON：`{ "error": { "code": "...", "message": "..." } }`，状态码透传上游（如 401/429）。流中途出错则以 `{"error": {...}}` 事件 + `[DONE]` 结束。

## 安全边界

- **Base URL 白名单**：浏览器只能提交预设 id 或 `custom` + 一个 https 公网地址；Worker 会拒绝内网地址（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`*.local` 等），避免接口被当成开放代理。
- **模型名只接受字符串**，不参与 URL 拼接；密钥只经请求头传入，不写日志。
- **限流**：使用 Workers 的 `ratelimits` binding（每边缘位置近似计数）。
- **Markdown**：`marked` 输出经 DOMPurify 清洗，链接统一加 `rel="noopener noreferrer"`。
- **CSP**：`web/public/_headers` 里给出基础策略，静态资源由 Workers 直接托管。

## 加一个新的提供商

1. 在 `shared/models.ts` 的 `COMPAT_PRESETS` 里加一条（id / label / baseUrl / models / keyUrl）。
2. 如果它不是 OpenAI 兼容协议（例如 Anthropic 原生接口），在 `src/providers/` 新建适配器，返回 `AsyncGenerator<Delta>`，然后在 `src/chat.ts` 的 `streamChat` 里分支。
3. 前端设置面板会自动读到新预设，无需改动 UI。

## 部署细节

- `wrangler.jsonc`：`main` 指向 Worker，`assets.directory` 指向 `./dist/client`，`not_found_handling: single-page-application` 让前端路由回落到 `index.html`。
- CI（`.github/workflows/deploy.yml`）先跑 `pnpm check` + `pnpm build`，再在 `main` 上用 `cloudflare/wrangler-action@v4` 执行 `wrangler deploy --minify`。
- 不要同时开启 Cloudflare 自带的 Git 集成，否则会和 Actions 互相覆盖。
- 预览环境可另外接 `wrangler versions upload`（当前未启用）。
