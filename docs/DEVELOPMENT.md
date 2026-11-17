# 开发说明

面向维护者与二次开发者。用户向的部署与使用说明见 [README](../README.md)。

## 架构

```
浏览器 SPA（Vite 构建，产物由 Worker 的静态资源托管）
  │  POST /api/chat   { provider, model, messages, ... }   → SSE
  │  POST /api/image  { provider, model, prompt, ratio, ... } → JSON
  │  header: x-provider-key（BYOK 时携带）
  ▼
单个 Worker（src/index.ts）
  ├─ /api/chat     → 提供商适配器 → 归一化 SSE
  │                   ├─ Workers AI binding（默认，免密钥）
  │                   ├─ OpenAI 兼容 HTTP（预设或自定义 Base URL）
  │                   └─ mock（仅本地，MOCK_AI=true 时可用）
  ├─ /api/image    → 图像适配器 → JSON { images: [{ base64, mimeType, width, height }] }
  │                   ├─ Workers AI binding（json / multipart 两种输入形状）
  │                   ├─ OpenAI 兼容 /images/generations（强制 b64_json）
  │                   └─ mock（本地 SVG 占位图）
  └─ /api/catalog  → 前端可用的模型/提供商清单（含图像）
```

设计要点：

1. **浏览器只与自己的 Worker 通信**。第三方密钥经 Worker 转发，避免 CORS 与密钥暴露在跨域请求里。
2. **Workers AI 的流式形状不统一**。`AI.run(..., { stream: true })` 现在返回 `ReadableStream`（二进制 SSE），历史版本还出现过 `{ response }` 对象流与纯文本流，`src/providers/workers-ai.ts` 会统一归一化；SSE 靠内容自动识别，不靠猜测。
3. **只有一种流协议**。所有提供商都被归一化成 OpenAI 的 SSE 形状：正文走 `choices[0].delta.content`，思考过程走 `choices[0].delta.reasoning_content`，前端只写一个解析器。额外事件：`{"cf-chat": {...}}` 用于元信息（实际使用的模型、是否降级、`reset` 重试清屏、本轮 `usage`）。
4. **不缓冲**。上游响应直接 `pipeThrough`/逐块转发，Worker 只是 I/O，不占 CPU（免费版 CPU 上限 10ms/次）。
5. **客户端断开即取消**。前端 `AbortController` → `request.signal` → 上游 `fetch` 取消。
6. **图像不走 SSE**。图像模型不流式，一次请求返回完整图片；`/api/image` 直接回 JSON，前端拿到 base64 后转 WebP 存 IndexedDB，消息里只留 id。
7. **图像模型的输入形状不统一**，这是最容易踩的坑，所以做成数据（`shared/images.ts` 的 `input`/`output` 字段）而不是散落的 if：
   - `flux-1-schnell`：普通 JSON，且 schema 是 `additionalProperties: false`，只认 `prompt` + `steps`，传宽高会 400。
   - `flux-2-klein-9b` / `flux-2-klein-4b` / `flux-2-dev`：**multipart form-data**，即使只有提示词。binding 里必须 `new Response(form)` 拿到序列化 body 与带 boundary 的 content-type。
   - `leonardo/phoenix-1.0`：JSON 输入，但输出是**二进制 JPEG**（其余模型都是 `{ image: base64 }`）。
   - `leonardo/lucid-origin`：JSON 输入，`{ image: base64 }` 输出。

## 目录结构

```
shared/models.ts          提供商预设、Workers AI 模型清单（前后端共用）
shared/images.ts          图像模型清单（输入/输出形状、尺寸范围、计费估算）、比例、图像预设
shared/tokens.ts          Usage 类型、字符估算、usage 归一化（前后端共用）
src/
  index.ts                路由
  chat.ts                 请求校验、限流、提供商解析、降级逻辑
  images.ts               /api/image：校验、限流、图像提供商解析
  catalog.ts              /api/catalog
  sse.ts                  归一化 SSE 输出
  http.ts                 JSON 辅助
  types.ts                Env、Delta、ProviderError
  providers/
    workers-ai.ts         AI binding 适配（messages / Gemma prompt 双格式）
    openai-compatible.ts  OpenAI 兼容 SSE 透传
    mock.ts               本地演示
    workers-ai-image.ts   图像 binding 适配（json/multipart 输入、base64/二进制输出归一化）
    openai-image.ts       OpenAI 兼容 /images/generations
    mock-image.ts         本地 SVG 占位图
web/
  index.html              页面骨架（含模式切换、图像参数栏、灯箱）
  src/ui.ts               应用控制器（渲染、流式、画图、设置面板）
  src/store.ts            设置与对话持久化
  src/api.ts              SSE 客户端
  src/image-api.ts        /api/image 客户端
  src/image-store.ts      图片压缩（WebP）与 IndexedDB 独立 store、孤儿清理
  src/usage.ts            单条回复与整段对话的 token 统计
  src/background.ts       背景图压缩与 IndexedDB 存取
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
  "model": "deepseek-flash",
  "messages": [{ "role": "user", "content": "hi" }],
  "temperature": 0.7,
  "maxTokens": 4096,
  "thinking": "auto" | "on" | "off"
}
```

校验规则：`messages` 1–100 条、单条 ≤20000 字符、合计 ≤120000 字符；`maxTokens` 上限 8192；`provider` 必须命中白名单。

思考开关的映射：

- Workers AI：对 qwen3 / gemma-4 / glm-4 / nemotron 系列传 `chat_template_kwargs.enable_thinking`；其他模型忽略。`qwen3.8-27b` 与 `gemma-4-26b-a4b-it` 都认这个开关。
- OpenAI 兼容（DeepSeek）：`thinking: { "type": "enabled" | "disabled" }`，仅当 Base URL 的主机名以 `deepseek.com` 结尾时附加。
- `auto` 不传任何参数，跟随模型默认。

响应：`text/event-stream`，事件体均为 `data: {...}`。

```
data: {"cf-chat":{"provider":"workers-ai","model":"@cf/...","fallback":false}}
data: {"choices":[{"index":0,"delta":{"reasoning_content":"先确认问题…"}}]}
data: {"choices":[{"index":0,"delta":{"content":"你"}}]}
data: {"choices":[{"index":0,"delta":{"content":"好"}}]}
data: {"cf-chat":{"usage":{"promptTokens":1024,"completionTokens":356,"totalTokens":1380,"estimated":false}}}
data: [DONE]
```

`usage` 固定是本轮最后一帧（`[DONE]` 之前）。`promptTokens` 是这一轮实际发出的上下文（含系统提示词与最近 20 条历史），`completionTokens` 含思考内容；`estimated: true` 表示数字来自字符估算而不是提供商。

如果默认模型只产出思考、没有正文，Worker 会先发 `{"cf-chat":{"reset":true}}` 清掉前端已渲染的内容，再发降级 meta 并用备用模型重试。

出错（发生在流开始前）返回 JSON：`{ "error": { "code": "...", "message": "..." } }`，状态码透传上游（如 401/429）。流中途出错则以 `{"error": {...}}` 事件 + `[DONE]` 结束。

## Token 用量

数字有两个来源，前端只认 `Usage` 类型，不区分提供商：

- **OpenAI 兼容**：请求附加 `stream_options.include_usage`；上游以 400/422 拒绝该字段时会自动去掉再重试一次（避免严格服务商直接失败）。usage 取流里最后一帧，兼容 OpenAI 那种 `choices: []` 的独立 usage 帧；DeepSeek 默认就把它挂在最后一个内容帧上。提供商完全不返回时退化为估算。
- **Workers AI**：实测 qwen3 会在分片里带 `usage`，但同一个流里会出现多次（首个是 0/0/0 的占位），只取最后一个非零值并在结束时统一发一帧。没有 usage 的模型（例如部分 prompt 风格模型）退化为估算。
- **估算规则**（`shared/tokens.ts`）：CJK 字符约 0.6 token/字、ASCII 约 0.3 token/字符、emoji 约 2 token/个，每条消息再加 4 token 的结构开销，整体 +3。误差通常在一两成以内，够用来判断额度消耗，不应当拿来做精确计费。

`completionTokens` 包含思考内容（DeepSeek 同时给出 `reasoningTokens`）。前端把 usage 随消息存进 IndexedDB；旧消息、被中断的流没有服务端数据时，在 `web/src/usage.ts` 里按同一套规则本地估算，并标 `≈`（整段对话里如果只有部分回复是估算的，改标「含估算」）。整段对话的「累计」是各轮 `promptTokens + completionTokens` 求和，因为每轮都会重新携带历史，它天然大于「本轮输入」。

## /api/image 契约

请求：

```jsonc
{
  "provider": "workers-ai" | "openai-compatible" | "mock",
  "presetId": "tokenrhythm",        // 或 "custom"
  "baseUrl": "https://.../v1",      // 仅 custom 时使用
  "model": "@cf/black-forest-labs/flux-2-klein-9b",
  "prompt": "一只在窗台上晒太阳的橘猫，水彩风格",
  "negativePrompt": "",             // 仅部分模型支持
  "ratio": "1:1",                   // 1:1 / 16:9 / 9:16 / 4:3 / 3:4
  "count": 1,                       // 1–4
  "steps": 0,                       // 0 = 用模型默认值
  "guidance": 0,                    // 0 = 用模型默认值
  "seed": 12345,                    // 可选
  "inputImages": [                  // 可选，图生图的参考图
    { "base64": "iVBORw0KGgo…", "mimeType": "image/png" }
  ]
}
```

校验规则：`prompt` 非空且 ≤2000 字符；`negativePrompt` ≤500 字符；`count` 1–4；`provider` 必须命中白名单。宽高由 `ratio` 经 `clampSize()` 收敛到模型允许的范围（`flux-2-*` 256–1920、`phoenix` 256–2048、`lucid-origin` 256–2500），客户端不能直接指定像素。

`inputImages` 最多 4 张，每张 base64 长度 ≤1.5 MB，`mimeType` 必须以 `image/` 开头。只有 `flux-2-*` 支持（`shared/images.ts` 的 `maxInputImages`），其他模型传了会返回 400 `input_image_unsupported`。模型要求每张参考图**小于 512×512**，且不会自己缩放——所以浏览器在 `toInputImage()` 里先压到 511 再发，超限会直接报错而不是自动缩小。

响应：

```jsonc
{
  "images": [
    { "base64": "iVBORw0KGgo…", "mimeType": "image/png", "width": 1024, "height": 1024 }
  ],
  "meta": { "provider": "workers-ai", "model": "@cf/…", "width": 1024, "height": 1024, "steps": 4, "neurons": 1363.64 }
}
```

`meta.neurons` 只是按官方价目表估算的额度消耗，用来在参数栏提示，不参与计费。OpenAI 兼容分支固定为 0。

出错返回 JSON：`{ "error": { "code": "...", "message": "..." } }`，状态码透传上游（401/429 等）。

### 各模型的输入形状

| 模型 | 输入 | 输出 | 尺寸可控 | 步数 | 引导 | 负面提示词 | 参考图 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `flux-2-klein-9b` | multipart | `{image}` base64 | 256–1920 | 固定 4 | 有 | 无 | 最多 4 张 |
| `flux-2-klein-4b` | multipart | `{image}` base64 | 256–1920 | 固定 4 | 有 | 无 | 最多 4 张 |
| `flux-2-dev` | multipart | `{image}` base64 | 256–1920 | 1–50 | 有 | 无 | 最多 4 张 |
| `flux-1-schnell` | json | `{image}` base64 | **不可控** | 1–8 | 无 | 无 | 不支持 |
| `phoenix-1.0` | json | **二进制 JPEG** | 256–2048 | 1–50 | 有 | 有 | 不支持 |
| `lucid-origin` | json | `{image}` base64 | 256–2500 | 1–40 | 有 | 无 | 不支持 |

multipart 的写法（binding 侧）：

```ts
const form = new FormData();
form.append("prompt", prompt);
form.append("width", String(width));
form.append("height", String(height));
// 参考图必须叫 input_image_0..3，别的名字模型会静默忽略。
form.append("input_image_0", blob, "input-0.png");
// FormData 不暴露序列化后的 body 与 boundary，必须过一遍 Response。
const serialized = new Response(form);
await env.AI.run(model, {
  multipart: {
    body: serialized.body,
    contentType: serialized.headers.get("content-type")!,
  },
});
```

### 额度消耗

按官方价目表（10000 neurons/天免费额度）：

| 模型 | 1024×1024 约消耗 | 免费额度约可画 |
| --- | --- | --- |
| `flux-2-klein-9b` | 1364 neurons | 7 张 |
| `flux-2-klein-4b` | 104 neurons | 96 张 |
| `flux-1-schnell` | 58 neurons | 170 张 |
| `flux-2-dev` | 3750 neurons（25 步） | 2 张 |
| `phoenix-1.0` | 2370 neurons（25 步） | 4 张 |
| `lucid-origin` | 2544 neurons（25 步） | 3 张 |

`estimateNeurons()` 复刻了这套算法，改价目表时同步改它。

### 图片存储

图片不进对话记录。`web/src/image-store.ts` 用 `idb-keyval` 的 `createStore("cf-chat", "images")` 开独立 store：

1. 拿到 base64 → `Blob` → 解码 → 画到 canvas（长边压到 1536px）→ `toBlob("image/webp", 0.9)`。
2. 存 `{ id, blob, width, height, bytes, createdAt }`，消息里只留 `{ id, width, height, bytes }`。
3. 显示时按 id 取 blob 并缓存 object URL（`urlCache`），避免重复解码。
4. 删除会话时按 id 删；页面加载时 `pruneImages()` 清掉没有任何消息引用的孤儿。

这样做的原因：一张 1024×1024 PNG 有几百 KB，若内联进 `Conversation`，每次保存会话都要重写几 MB，很快会撞上 IndexedDB 的写入限制。

## 安全边界

- **Base URL 白名单**：浏览器只能提交预设 id 或 `custom` + 一个 https 公网地址；Worker 会拒绝内网地址（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`*.local` 等），避免接口被当成开放代理。对话与画图两条链路各有一份同样的校验。
- **模型名只接受字符串**，不参与 URL 拼接；密钥只经请求头传入，不写日志。
- **限流**：使用 Workers 的 `ratelimits` binding（每边缘位置近似计数）。对话 12 次/60 秒/IP，画图 3 次/60 秒/IP——画图单次成本高，限得更紧。
- **Markdown**：`marked` 输出经 DOMPurify 清洗，链接统一加 `rel="noopener noreferrer"`；思考过程按纯文本写入 `textContent`，不经过 HTML 解析。
- **背景图与生成的图片**：仅存于浏览器 IndexedDB（背景图压到最长边 1920px，生成的图片转 WebP 压到 1536px），不上传服务端。
- **图像尺寸由服务端决定**：客户端只能选比例 id，像素由 `clampSize()` 按模型能力收敛，避免用超大尺寸刷额度。
- **CSP**：`web/public/_headers` 里给出基础策略，静态资源由 Workers 直接托管。

## 加一个新的提供商

对话：

1. 在 `shared/models.ts` 的 `COMPAT_PRESETS` 里加一条（id / label / baseUrl / models / keyUrl）。
2. 如果它不是 OpenAI 兼容协议（例如 Anthropic 原生接口），在 `src/providers/` 新建适配器，返回 `AsyncGenerator<Delta>`，然后在 `src/chat.ts` 的 `streamChat` 里分支。
3. 前端设置面板会自动读到新预设，无需改动 UI。

画图：

1. Workers AI 新模型：在 `shared/images.ts` 的 `WORKERS_AI_IMAGE_MODELS` 加一条，**必须填对 `input`（json/multipart）与 `output`（base64/binary）**，否则运行期才会炸。`src/providers/workers-ai-image.ts` 会按这两个字段自动组装请求并归一化输出。
2. OpenAI 兼容图像服务：在 `IMAGE_PRESETS` 加一条即可，适配器固定请求 `b64_json`。
3. 前端设置面板与比例/张数参数栏都会自动读到新条目。

## 部署细节

- `wrangler.jsonc`：`main` 指向 Worker，`assets.directory` 指向 `./dist/client`，`not_found_handling: single-page-application` 让前端路由回落到 `index.html`。
- CI（`.github/workflows/deploy.yml`）先跑 `pnpm check` + `pnpm build`，再在 `main` 上用 `cloudflare/wrangler-action@v4` 执行 `wrangler deploy --minify`。
- 不要同时开启 Cloudflare 自带的 Git 集成，否则会和 Actions 互相覆盖。
- 预览环境可另外接 `wrangler versions upload`（当前未启用）。
