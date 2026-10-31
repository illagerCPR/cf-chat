# cf-chat

一个跑在 Cloudflare Workers 上的极简 AI 对话页面。默认使用 Workers AI（不需要任何密钥），也可以切换到任意 OpenAI 兼容的提供商，用自己的 API Key 对话。

## 特性

- **流式输出**：逐字到达，可随时中断，Markdown 与代码块正常渲染
- **思考过程**：支持思考的模型会把推理过程单独显示在可折叠面板里，可开关、可隐藏
- **Token 用量**：每条回复给出本轮输入/输出 token，输入框上方汇总整段对话的累计消耗与本轮输入大小
- **自定义背景**：在设置里上传一张图片作为页面背景，遮罩强度可调，图片只存在本机
- **默认零配置**：部署后直接用 Workers AI 对话，访客不需要密钥
- **自带密钥（BYOK）**：OpenAI、DeepSeek（`deepseek-flash` / `deepseek-v4-pro`）、Moonshot、智谱 GLM、SiliconFlow、OpenRouter 以及任意 OpenAI 兼容服务
- **自动降级**：默认模型不可用时自动换到备用模型，并在回复下方标注
- **多会话**：历史对话保存在本浏览器（IndexedDB），支持切换、删除、重新生成
- **单 Worker 部署**：静态页面免费，接口与页面同域，没有 CORS 问题
- **自动部署**：推送到 `main` 即由 GitHub Actions 部署

## 部署到 Cloudflare

需要一个 Cloudflare 账号，以及本仓库的一份 fork。

### 1. 创建 API Token

Cloudflare 控制台 → 头像 → **My Profile** → **API Tokens** → **Create Token** → **Custom token**，权限：

| 范围 | 权限 |
| --- | --- |
| Account · Workers Scripts | Edit |
| Account · Workers AI | Read |

保存后复制 Token（只显示一次）。Account ID 在控制台右侧栏或 Workers 概览页可以找到。

### 2. 配置仓库 Secrets

在你的 fork 里：**Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### 3. 推送即部署

向 `main` 推送（或在 Actions 页面手动运行 **Deploy**），完成后访问：

```
https://cf-chat.<你的 workers.dev 子域>.workers.dev
```

> 没有配置 Secrets 时，构建仍会通过，部署步骤会自动跳过并给出提示。

## 使用

页面右下角齿轮进入设置：

- **提供商 · Workers AI**：无需密钥。模型留空即使用服务端默认模型。
- **提供商 · OpenAI 兼容**：选择服务商、填入自己的 API Key 和模型名称。自定义服务填 Base URL（必须 https，接口需兼容 `/chat/completions`）。
- **思考模式**：可选「自动 / 开启 / 关闭」。自动跟随模型默认；开启后推理过程会显示在回复上方，可折叠。思考内容也计入「最大回复 tokens」。
- **Token 用量**：默认开启。每条回复下方显示本轮输入、输出与合计 token；输入框上方汇总这段对话的累计消耗和本轮输入大小。提供商返回用量时是精确值，拿不到时按字符估算（数字前带 `≈`）。设置里可以关掉。
- **背景图片**：选择本地图片即可，浏览器会先压缩再存入 IndexedDB，换设备不会同步。

API Key 只保存在当前浏览器的 localStorage，不会写入服务端存储。对话内容同理，只存在本机。

## 可选：限制访问

默认任何人拿到域名都能用，会消耗你账号的 Workers AI 免费额度。用 Cloudflare Access 可以只放行自己：

Cloudflare 控制台 → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**，域名填 Worker 域名，策略设为 `Allow` + 你的邮箱。之后访问会先要求登录。

## 配置

| 项目 | 位置 | 说明 |
| --- | --- | --- |
| 默认模型 | `wrangler.jsonc` → `vars.DEFAULT_MODEL` | 默认 `@cf/qwen/qwen3-30b-a3b-fp8` |
| 降级模型 | `wrangler.jsonc` → `vars.FALLBACK_MODEL` | 默认 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| 提供方列表 | `shared/models.ts` | 增删预设或改默认 Base URL |
| 服务端默认密钥 | `wrangler secret put OPENAI_COMPAT_API_KEY` | 可选；让访客不填 Key 也能用某个服务商 |
| 限流 | `wrangler.jsonc` → `ratelimits` | 默认 12 次 / 60 秒 / IP |

## 已知限制

- Workers AI 免费额度为 10000 Neurons/天（`00:00 UTC` 重置），额度用尽后对话会失败
- 默认的 `qwen3-30b-a3b-fp8` 是 MoE 模型，中文表现不错；如果想更省额度可以换回 `@cf/google/gemma-2b-it-lora`（2B，中文较弱）
- `@cf/google/gemma-3-12b-it` 等部分模型需要账户具备权限，免费账户可能返回 `5018: This account is not allowed to access …`
- 思考内容计入输出 tokens；默认模型开思考时，每轮消耗的 Neurons 约为关闭时的数倍，免费额度用得更快
- Token 用量里的「累计」是每轮实际发出的输入加输出之和，历史会重复携带，所以通常远大于「本轮输入」；提供商不返回用量时，数字是按字符估算的近似值
- 每轮只带最近 20 条消息，长对话不会无限增长
- 对话不跨设备同步（没有账号系统）

## 本地运行

需要 Node 22 及以上、pnpm 11。

```bash
pnpm install
pnpm dev
```

打开 <http://localhost:5173>。本地默认进入**演示模式**（由 Worker 生成模拟回复），不需要 Cloudflare 账号就能看完整交互。

开发与部署的内部细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## License

[MIT](LICENSE)
