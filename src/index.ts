import { handleCatalog } from "./catalog";
import { handleChat } from "./chat";
import { jsonError } from "./http";
import { errorMessage, type Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/chat") return await handleChat(request, env);
      if (url.pathname === "/api/catalog" && request.method === "GET") {
        return await handleCatalog(env);
      }
      if (url.pathname.startsWith("/api/")) {
        return jsonError(404, "not_found", "接口不存在。");
      }
      if (env.ASSETS) return await env.ASSETS.fetch(request);

      return jsonError(404, "not_found", "页面不存在。");
    } catch (error) {
      return jsonError(500, "internal_error", errorMessage(error));
    }
  },
} satisfies ExportedHandler<Env>;
