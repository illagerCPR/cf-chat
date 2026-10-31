import { COMPAT_PRESETS, WORKERS_AI_MODELS, findPreset } from "../../shared/models";
import type { ProviderKind } from "../../shared/models";
import { ChatError, fetchCatalog, streamChat, type Catalog, type StreamEvent } from "./api";
import { decorateLinks, renderMarkdown } from "./markdown";
import {
  createConversation,
  createMessage,
  loadConversations,
  loadSettings,
  saveConversations,
  saveSettings,
  toApiMessages,
  type Conversation,
  type MessageMeta,
  type MessageRecord,
  type Settings,
} from "./store";
import { relativeTime, shortModelName, throttle, truncateTitle } from "./util";

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`缺少页面元素：${selector}`);
  return element;
}

function textButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-btn";
  button.textContent = label;
  return button;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface Elements {
  sidebar: HTMLElement;
  scrim: HTMLElement;
  closeSidebar: HTMLButtonElement;
  openSidebar: HTMLButtonElement;
  newChat: HTMLButtonElement;
  conversationList: HTMLElement;
  openSettings: HTMLButtonElement;
  modelChip: HTMLElement;
  chatTitle: HTMLElement;
  status: HTMLElement;
  messages: HTMLElement;
  composer: HTMLFormElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  settingsDialog: HTMLDialogElement;
}

export class App {
  private settings: Settings;
  private conversations: Conversation[] = [];
  private activeId: string | null = null;
  private controller: AbortController | null = null;
  private catalog: Catalog | null = null;

  private readonly els: Elements = {
    sidebar: must("#sidebar"),
    scrim: must("#scrim"),
    closeSidebar: must("#close-sidebar"),
    openSidebar: must("#open-sidebar"),
    newChat: must("#new-chat"),
    conversationList: must("#conversation-list"),
    openSettings: must("#open-settings"),
    modelChip: must("#model-chip"),
    chatTitle: must("#chat-title"),
    status: must("#status"),
    messages: must("#messages"),
    composer: must("#composer"),
    input: must("#input"),
    send: must("#send"),
    stop: must("#stop"),
    settingsDialog: must("#settings-dialog"),
  };

  constructor() {
    this.settings = loadSettings().settings;
  }

  async init(): Promise<void> {
    const { settings, persisted } = loadSettings();
    this.settings = settings;

    const [conversations, catalog] = await Promise.all([loadConversations(), fetchCatalog()]);
    this.conversations = conversations;
    this.catalog = catalog;

    // With no saved preferences and a demo-capable server (local dev), start in
    // demo mode so the page works before a Cloudflare account exists.
    if (!persisted && catalog?.mock) {
      this.settings = { ...this.settings, provider: "mock" };
      saveSettings(this.settings);
    }

    this.bindEvents();
    this.renderSidebar();
    this.updateChrome();

    if (this.conversations.length > 0) {
      this.selectConversation(this.conversations[0].id);
    } else {
      this.renderEmpty();
    }
  }

  // ---------------------------------------------------------------- rendering

  private renderEmpty(): void {
    const demo = this.settings.provider === "mock";
    this.els.messages.innerHTML = `
      <section class="empty-state">
        <h2>${demo ? "本地演示模式" : "开始一段对话"}</h2>
        <p>${
          demo
            ? "当前不会调用真实模型：回复由 Worker 内置的 mock 提供商逐字生成，用来验证流式渲染与页面交互。在设置里切换到 Workers AI 或自带密钥的提供商即可接入真实模型。"
            : "默认使用 Cloudflare Workers AI，无需任何密钥。想换成别的模型，先在设置里选一个提供商，填上你自己的 API Key 即可。"
        }</p>
      </section>`;
  }

  private renderSidebar(): void {
    const list = this.els.conversationList;
    list.replaceChildren();

    if (this.conversations.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "还没有对话";
      list.append(empty);
      return;
    }

    const sorted = [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const conversation of sorted) {
      const item = document.createElement("div");
      item.className = "conversation-item";
      if (conversation.id === this.activeId) item.classList.add("active");

      const open = document.createElement("button");
      open.type = "button";
      open.className = "item-open";
      open.title = conversation.title;

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = conversation.title;

      const stamp = document.createElement("span");
      stamp.className = "stamp";
      stamp.textContent = relativeTime(conversation.updatedAt);

      open.append(title, stamp);
      open.addEventListener("click", () => this.selectConversation(conversation.id));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete";
      remove.title = "删除对话";
      remove.setAttribute("aria-label", "删除对话");
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M18 7l-1 13H7L6 7"/></svg>';
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.deleteConversation(conversation.id);
      });

      item.append(open, remove);
      list.append(item);
    }

  }

  private buildMessage(record: MessageRecord, isLast = false): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `msg ${record.role}`;
    wrap.dataset.id = record.id;
    if (record.error) wrap.classList.add("error");

    if (record.role === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = "AI";
      wrap.append(avatar);
    }

    const body = document.createElement("div");
    body.className = "body";

    if (record.role === "assistant") {
      const prose = document.createElement("div");
      prose.className = "prose";
      prose.innerHTML = renderMarkdown(record.content);
      decorateLinks(prose);
      body.append(prose);

      if (record.error) {
        const note = document.createElement("p");
        note.className = "error-note";
        note.textContent = record.error;
        body.append(note);
      }

      if (record.meta?.model) {
        const meta = document.createElement("div");
        meta.className = "meta";
        const parts = [shortModelName(record.meta.model)];
        if (record.meta.fallback) parts.push("默认模型不可用，已自动降级");
        if (record.meta.reason === "stopped") parts.push("已停止");
        meta.textContent = parts.join(" · ");
        body.append(meta);
      }

      if (record.content.trim() || isLast) {
        const actions = document.createElement("div");
        actions.className = "actions";

        if (record.content.trim()) {
          const copy = textButton("复制");
          copy.addEventListener("click", () => {
            void navigator.clipboard.writeText(record.content).then(() => {
              copy.textContent = "已复制";
              window.setTimeout(() => {
                copy.textContent = "复制";
              }, 1200);
            });
          });
          actions.append(copy);
        }

        if (isLast) {
          const retry = textButton("重新生成");
          retry.addEventListener("click", () => void this.regenerate());
          actions.append(retry);
        }

        if (actions.childElementCount > 0) body.append(actions);
      }
    } else {
      body.textContent = record.content;
    }

    wrap.append(body);
    return wrap;
  }

  private renderConversation(conversation: Conversation): void {
    this.els.messages.replaceChildren();

    if (conversation.messages.length === 0) {
      this.renderEmpty();
      return;
    }

    conversation.messages.forEach((message, index) => {
      const isLast = index === conversation.messages.length - 1;
      this.els.messages.append(this.buildMessage(message, isLast && message.role === "assistant"));
    });
    this.scrollToBottom(true);
  }

  private updateChrome(): void {
    const conversation = this.activeConversation();
    this.els.chatTitle.textContent = conversation?.title ?? "新对话";

    if (this.settings.provider === "mock") {
      this.els.modelChip.textContent = "演示模式";
      return;
    }
    if (this.settings.provider === "workers-ai") {
      const model =
        this.settings.workersModel || this.catalog?.workersAI.defaultModel || "Workers AI";
      this.els.modelChip.textContent = shortModelName(model);
      return;
    }
    const preset = findPreset(this.settings.presetId);
    const model = this.compatModel();
    this.els.modelChip.textContent = preset ? `${preset.label} · ${shortModelName(model)}` : shortModelName(model);
  }

  // ------------------------------------------------------------------- state

  private activeConversation(): Conversation | undefined {
    return this.conversations.find((conversation) => conversation.id === this.activeId);
  }

  private ensureConversation(): Conversation {
    const existing = this.activeConversation();
    if (existing) return existing;

    const conversation = createConversation();
    this.conversations.unshift(conversation);
    this.activeId = conversation.id;
    return conversation;
  }

  private compatModel(): string {
    const typed = this.settings.compatModel.trim();
    if (typed) return typed;
    const preset = findPreset(this.settings.presetId);
    return preset?.models[0] ?? "";
  }

  private currentKey(): string | undefined {
    if (this.settings.provider !== "openai-compatible") return undefined;
    const key = this.settings.keys[this.settings.presetId]?.trim();
    return key || undefined;
  }

  private selectConversation(id: string): void {
    if (this.controller) this.stop();
    this.activeId = id;
    const conversation = this.activeConversation();
    if (!conversation) return;
    this.renderConversation(conversation);
    this.renderSidebar();
    this.updateChrome();
    this.toggleSidebar(false);
  }

  private startNewConversation(): void {
    if (this.controller) this.stop();
    this.activeId = null;
    this.renderEmpty();
    this.renderSidebar();
    this.updateChrome();
    this.toggleSidebar(false);
    this.els.input.focus();
  }

  private async deleteConversation(id: string): Promise<void> {
    this.conversations = this.conversations.filter((conversation) => conversation.id !== id);
    if (this.activeId === id) {
      this.activeId = null;
      this.renderEmpty();
    }
    this.renderSidebar();
    this.updateChrome();
    await saveConversations(this.conversations);
  }

  // ------------------------------------------------------------------ sending

  private async send(): Promise<void> {
    if (this.controller) return;
    const text = this.els.input.value.trim();
    if (!text) return;

    if (this.settings.provider === "openai-compatible" && !this.currentKey() && !this.catalog?.serverKey) {
      this.openSettings("这个提供商需要 API Key，先填一个再发消息。");
      return;
    }
    if (this.settings.provider === "openai-compatible" && this.settings.presetId === "custom") {
      if (!this.settings.customBaseUrl.trim()) {
        this.openSettings("自定义提供商需要先填写 Base URL。");
        return;
      }
    }

    this.els.input.value = "";
    this.resizeInput();

    const conversation = this.ensureConversation();
    const userMessage = createMessage("user", text);
    conversation.messages.push(userMessage);
    if (conversation.messages.filter((message) => message.role === "user").length === 1) {
      conversation.title = truncateTitle(text);
    }
    conversation.updatedAt = Date.now();

    this.els.messages.querySelector(".empty-state")?.remove();
    this.els.messages.append(this.buildMessage(userMessage));
    this.renderSidebar();
    this.updateChrome();
    this.scrollToBottom(true);

    await this.requestAssistant(conversation);
  }

  private async requestAssistant(conversation: Conversation): Promise<void> {
    const assistant = createMessage("assistant", "");
    conversation.messages.push(assistant);

    const node = this.buildMessage(assistant, true);
    this.els.messages.append(node);
    this.scrollToBottom(true);

    const prose = node.querySelector<HTMLElement>(".prose");
    const controller = new AbortController();
    this.controller = controller;
    this.setStreaming(true);

    let buffer = "";
    let meta: MessageMeta | undefined;
    let stopped = false;

    const flush = throttle(() => {
      if (!prose) return;
      prose.innerHTML = renderMarkdown(buffer);
      decorateLinks(prose);
      this.scrollToBottom();
    }, 70);

    try {
      for await (const event of streamChat(
        this.buildRequest(conversation, assistant),
        this.currentKey(),
        controller.signal,
      )) {
        this.handleEvent(event, {
          onDelta: (text) => {
            buffer += text;
            if (prose) prose.classList.add("cursor");
            flush();
          },
          onMeta: (data) => {
            meta = { model: String(data.model ?? ""), provider: String(data.provider ?? "") };
            if (data.fallback) meta.fallback = true;
          },
          onError: (message) => {
            throw new ChatError(message);
          },
        });
      }
    } catch (error) {
      if (isAbortError(error)) {
        stopped = true;
      } else if (error instanceof ChatError) {
        assistant.error = error.message;
        if (error.status === 401) this.openSettings(error.message);
        this.showStatus(error.message, true);
      } else if (error instanceof Error) {
        assistant.error = error.message;
        this.showStatus(error.message, true);
      } else {
        assistant.error = "请求失败。";
      }
    } finally {
      assistant.content = buffer;
      if (meta) assistant.meta = meta;
      if (stopped) {
        assistant.meta = { ...(meta ?? { model: "", provider: "" }), reason: "stopped" } as MessageMeta;
        if (!assistant.content.trim()) assistant.error = "已停止生成。";
      }

      this.controller = null;
      this.setStreaming(false);
      conversation.updatedAt = Date.now();
      conversation.messages = conversation.messages.map((message) =>
        message.id === assistant.id ? assistant : message,
      );
      await saveConversations(this.conversations);
      this.renderSidebar();
      this.updateChrome();

      const fresh = this.buildMessage(assistant, true);
      node.replaceWith(fresh);
      this.scrollToBottom();
    }
  }

  private handleEvent(
    event: StreamEvent,
    handlers: {
      onDelta: (text: string) => void;
      onMeta: (data: Record<string, unknown>) => void;
      onError: (message: string) => void;
    },
  ): void {
    if (event.type === "delta") handlers.onDelta(event.text);
    else if (event.type === "meta") handlers.onMeta(event.data);
    else handlers.onError(event.message);
  }

  private buildRequest(conversation: Conversation, _assistant: MessageRecord) {
    const messages = toApiMessages(conversation.messages, this.settings.systemPrompt);
    const shared = {
      messages,
      temperature: this.settings.temperature,
      maxTokens: this.settings.maxTokens,
    };

    if (this.settings.provider === "workers-ai") {
      return {
        ...shared,
        provider: "workers-ai" as const,
        model: this.settings.workersModel || undefined,
      };
    }
    if (this.settings.provider === "mock") {
      return { ...shared, provider: "mock" as const };
    }
    if (this.settings.presetId === "custom") {
      return {
        ...shared,
        provider: "openai-compatible" as const,
        presetId: "custom",
        baseUrl: this.settings.customBaseUrl.trim(),
        model: this.compatModel(),
      };
    }
    return {
      ...shared,
      provider: "openai-compatible" as const,
      presetId: this.settings.presetId,
      model: this.compatModel(),
    };
  }

  private async regenerate(): Promise<void> {
    if (this.controller) return;
    const conversation = this.activeConversation();
    if (!conversation) return;

    const last = conversation.messages[conversation.messages.length - 1];
    if (!last || last.role !== "assistant") return;

    conversation.messages.pop();
    this.renderConversation(conversation);
    await this.requestAssistant(conversation);
  }

  private stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.setStreaming(false);
  }

  private setStreaming(streaming: boolean): void {
    this.els.send.disabled = streaming;
    this.els.stop.hidden = !streaming;
    if (streaming) {
      this.showStatus("正在生成…");
    } else if (!this.els.status.classList.contains("error")) {
      this.els.status.textContent = "";
    }
  }

  private showStatus(message: string, isError = false): void {
    this.els.status.textContent = message;
    this.els.status.classList.toggle("error", isError);
    if (isError) {
      window.setTimeout(() => {
        if (this.els.status.textContent === message) {
          this.els.status.textContent = "";
          this.els.status.classList.remove("error");
        }
      }, 8000);
    }
  }

  private scrollToBottom(force = false): void {
    const element = this.els.messages;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (force || distance < 160) element.scrollTop = element.scrollHeight;
  }

  private resizeInput(): void {
    const input = this.els.input;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  private toggleSidebar(open: boolean): void {
    this.els.sidebar.classList.toggle("open", open);
    this.els.scrim.classList.toggle("show", open);
  }

  private bindEvents(): void {
    this.els.newChat.addEventListener("click", () => this.startNewConversation());
    this.els.openSettings.addEventListener("click", () => this.openSettings());
    this.els.openSidebar.addEventListener("click", () => this.toggleSidebar(true));
    this.els.closeSidebar.addEventListener("click", () => this.toggleSidebar(false));
    this.els.scrim.addEventListener("click", () => this.toggleSidebar(false));
    this.els.stop.addEventListener("click", () => this.stop());

    this.els.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.send();
    });

    this.els.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });
    this.els.input.addEventListener("input", () => this.resizeInput());
  }

  // ----------------------------------------------------------------- settings

  private openSettings(notice?: string): void {
    const dialog = this.els.settingsDialog;
    const presetOptions = COMPAT_PRESETS.map(
      (preset) => `<option value="${preset.id}">${preset.label}</option>`,
    ).join("");
    const workersHint = this.catalog?.workersAI.defaultModel ?? "@cf/qwen/qwen3-30b-a3b-fp8";
    const fallback = this.catalog?.workersAI.fallbackModel;
    const providerOptions = [
      `<option value="workers-ai">Workers AI（内置，无需密钥）</option>`,
      `<option value="openai-compatible">OpenAI 兼容提供商（自带密钥）</option>`,
      this.catalog?.mock ? `<option value="mock">演示模式（本地 mock）</option>` : "",
    ].join("");

    dialog.innerHTML = `
      <form class="settings-form" id="settings-form">
        <div class="settings-head">
          <h2>设置</h2>
          <button type="button" class="icon-btn" data-close aria-label="关闭">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="settings-body">
          ${notice ? `<div class="notice">${notice}</div>` : ""}
          <div class="field">
            <label for="set-provider">提供商</label>
            <select id="set-provider">${providerOptions}</select>
          </div>

          <div class="field" data-section="workers">
            <label for="set-workers-model">模型</label>
            <input id="set-workers-model" type="text" list="workers-models" placeholder="${workersHint}" />
            <datalist id="workers-models">
              ${WORKERS_AI_MODELS.map((model) => `<option value="${model.id}">${model.label}</option>`).join("")}
            </datalist>
            <p class="hint">留空使用服务端默认模型（当前 ${workersHint}）。${
              fallback ? `调用失败会自动降级到 ${fallback}。` : ""
            }</p>
          </div>

          <div class="field" data-section="compat">
            <label for="set-preset">服务商</label>
            <select id="set-preset">${presetOptions}<option value="custom">自定义（OpenAI 兼容）</option></select>
          </div>

          <div class="field" data-section="compat">
            <label for="set-key">API Key</label>
            <input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" />
            <p class="hint" id="key-hint">只保存在本浏览器，请求时经 Worker 转发，服务端不做存储。</p>
          </div>

          <div class="field" data-section="compat">
            <label for="set-model">模型名称</label>
            <input id="set-model" type="text" list="compat-models" spellcheck="false" />
            <datalist id="compat-models"></datalist>
          </div>

          <div class="field" data-section="compat" id="baseurl-field">
            <label for="set-baseurl">Base URL</label>
            <input id="set-baseurl" type="text" spellcheck="false" placeholder="https://example.com/v1" />
            <p class="hint">必须是 https 公网地址，且兼容 /chat/completions 接口。</p>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="set-temp">温度</label>
              <div class="range-row">
                <input id="set-temp" type="range" min="0" max="2" step="0.1" />
                <output id="temp-value"></output>
              </div>
            </div>
            <div class="field">
              <label for="set-tokens">最大回复 tokens</label>
              <input id="set-tokens" type="number" min="64" max="2048" step="64" />
            </div>
          </div>

          <div class="field">
            <label for="set-system">系统提示词</label>
            <textarea id="set-system" placeholder="可选。例如：你是一个简洁的中文助手，回答尽量短。"></textarea>
          </div>
        </div>
        <div class="settings-foot">
          <span class="note">对话与密钥均保存在浏览器本地</span>
          <button type="submit" class="primary-btn">保存</button>
        </div>
      </form>`;

    const form = dialog.querySelector<HTMLFormElement>("#settings-form");
    const providerSelect = dialog.querySelector<HTMLSelectElement>("#set-provider");
    const workersInput = dialog.querySelector<HTMLInputElement>("#set-workers-model");
    const presetSelect = dialog.querySelector<HTMLSelectElement>("#set-preset");
    const keyInput = dialog.querySelector<HTMLInputElement>("#set-key");
    const modelInput = dialog.querySelector<HTMLInputElement>("#set-model");
    const modelList = dialog.querySelector<HTMLDataListElement>("#compat-models");
    const baseUrlInput = dialog.querySelector<HTMLInputElement>("#set-baseurl");
    const baseUrlField = dialog.querySelector<HTMLElement>("#baseurl-field");
    const keyHint = dialog.querySelector<HTMLElement>("#key-hint");
    const tempInput = dialog.querySelector<HTMLInputElement>("#set-temp");
    const tempValue = dialog.querySelector<HTMLOutputElement>("#temp-value");
    const tokensInput = dialog.querySelector<HTMLInputElement>("#set-tokens");
    const systemInput = dialog.querySelector<HTMLTextAreaElement>("#set-system");
    const closeButton = dialog.querySelector<HTMLButtonElement>("[data-close]");

    if (
      !form ||
      !providerSelect ||
      !workersInput ||
      !presetSelect ||
      !keyInput ||
      !modelInput ||
      !modelList ||
      !baseUrlInput ||
      !baseUrlField ||
      !keyHint ||
      !tempInput ||
      !tempValue ||
      !tokensInput ||
      !systemInput ||
      !closeButton
    ) {
      return;
    }

    const preset = findPreset(this.settings.presetId);

    providerSelect.value = this.settings.provider;
    workersInput.value = this.settings.workersModel;
    presetSelect.value = this.settings.presetId;
    keyInput.value = this.settings.keys[this.settings.presetId] ?? "";
    modelInput.value = this.settings.compatModel || preset?.models[0] || "";
    baseUrlInput.value = this.settings.customBaseUrl;
    tempInput.value = String(this.settings.temperature);
    tempValue.textContent = this.settings.temperature.toFixed(1);
    tokensInput.value = String(this.settings.maxTokens);
    systemInput.value = this.settings.systemPrompt;

    const syncSections = (): void => {
      const provider = providerSelect.value as ProviderKind;
      const section = provider === "workers-ai" ? "workers" : provider === "mock" ? "none" : "compat";
      for (const field of dialog.querySelectorAll<HTMLElement>("[data-section]")) {
        field.hidden = field.dataset.section !== section;
      }
      baseUrlField.hidden = presetSelect.value !== "custom";
    };

    const syncPreset = (): void => {
      const current = findPreset(presetSelect.value);
      const models = current?.models ?? [];
      modelList.replaceChildren(
        ...models.map((model) => {
          const option = document.createElement("option");
          option.value = model;
          return option;
        }),
      );
      keyInput.value = this.settings.keys[presetSelect.value] ?? "";
      modelInput.value = models[0] ?? "";
      modelInput.placeholder = models[0] ?? "模型名称";

      if (current?.keyUrl) {
        keyHint.innerHTML = `只保存在本浏览器。还没有密钥？<a href="${current.keyUrl}" target="_blank" rel="noopener noreferrer">去 ${current.label} 申请</a>。`;
      } else {
        keyHint.textContent = "只保存在本浏览器，请求时经 Worker 转发，服务端不做存储。";
      }
      syncSections();
    };

    providerSelect.addEventListener("change", syncSections);
    presetSelect.addEventListener("change", syncPreset);
    tempInput.addEventListener("input", () => {
      tempValue.textContent = Number(tempInput.value).toFixed(1);
    });
    closeButton.addEventListener("click", () => dialog.close());

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const keys = { ...this.settings.keys };
      const typedKey = keyInput.value.trim();
      if (typedKey) keys[presetSelect.value] = typedKey;
      else delete keys[presetSelect.value];

      const temperature = Number(tempInput.value);
      const maxTokens = Number(tokensInput.value);

      this.settings = {
        ...this.settings,
        provider: providerSelect.value as ProviderKind,
        workersModel: workersInput.value.trim(),
        presetId: presetSelect.value,
        compatModel: modelInput.value.trim(),
        customBaseUrl: baseUrlInput.value.trim(),
        keys,
        temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.7,
        maxTokens: Number.isFinite(maxTokens) ? Math.min(2048, Math.max(64, maxTokens)) : 1024,
        systemPrompt: systemInput.value,
      };
      saveSettings(this.settings);
      dialog.close();
      this.updateChrome();
      this.renderEmptyIfEmpty();
    });

    syncPreset();
    syncSections();

    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  private renderEmptyIfEmpty(): void {
    const conversation = this.activeConversation();
    if (!conversation || conversation.messages.length === 0) this.renderEmpty();
  }
}
