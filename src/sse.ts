import { errorMessage, type Delta } from "./types";

const encoder = new TextEncoder();

function frame(delta: Delta): string {
  switch (delta.type) {
    case "meta":
      return `data: ${JSON.stringify({ "cf-chat": delta.data })}\n\n`;
    case "content":
      return `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: delta.value } }],
      })}\n\n`;
    case "reasoning":
      // OpenAI-compatible field used by DeepSeek and Qwen; the browser reads it
      // separately from `content` so it can render a collapsible thinking block.
      return `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: delta.value } }],
      })}\n\n`;
    case "reset":
      return `data: ${JSON.stringify({ "cf-chat": { reset: true } })}\n\n`;
    case "error":
      return `data: ${JSON.stringify({
        error: { message: delta.message, code: delta.code ?? "upstream_error" },
      })}\n\n`;
  }
}

const DONE = "data: [DONE]\n\n";

/**
 * Wraps a provider's delta stream into an OpenAI-shaped SSE response, so the
 * browser only ever has to parse one wire format.
 */
export function sseResponse(source: AsyncIterable<Delta>, signal?: AbortSignal): Response {
  const iterator = source[Symbol.asyncIterator]();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        await closeIterator(iterator);
        controller.close();
        return;
      }
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.enqueue(encoder.encode(DONE));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(frame(value)));
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            frame({ type: "error", message: errorMessage(error), code: "stream_failed" }),
          ),
        );
        controller.enqueue(encoder.encode(DONE));
        controller.close();
      }
    },
    async cancel() {
      await closeIterator(iterator);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function closeIterator(iterator: AsyncIterator<Delta>): Promise<void> {
  try {
    await iterator.return?.(undefined);
  } catch {
    // The upstream stream is already gone; nothing left to release.
  }
}
