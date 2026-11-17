import type { ImageRequest, GeneratedImage } from "./workers-ai-image";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrap(text: string, perLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const character of text) {
    current += character;
    if (current.length >= perLine) {
      lines.push(current);
      current = "";
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && text.length > lines.join("").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, perLine - 1)}…`;
  }
  return lines;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Offline placeholder used when `MOCK_AI` is on, so the image pipeline can be
 * exercised without a Cloudflare account or any key. It draws an SVG card with
 * the prompt and the requested size instead of pretending to be a real model.
 */
export async function runMockImage(request: ImageRequest): Promise<GeneratedImage> {
  const { width, height } = request;
  const lines = wrap(request.prompt.replace(/\s+/g, " ").trim(), 22, 5);
  const fontSize = Math.max(16, Math.round(Math.min(width, height) / 22));
  const lineHeight = Math.round(fontSize * 1.5);
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;

  const text = lines
    .map(
      (line, index) =>
        `<text x="${width / 2}" y="${startY + index * lineHeight}" text-anchor="middle" ` +
        `font-family="system-ui, sans-serif" font-size="${fontSize}" fill="#1b1b19">` +
        `${escapeXml(line)}</text>`,
    )
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fdf6ec"/>
      <stop offset="100%" stop-color="#f6e3c9"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="none" stroke="#f6821f" stroke-width="3" stroke-dasharray="14 10" rx="18"/>
  ${text}
  <text x="${width / 2}" y="${height - 28}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(fontSize * 0.62)}" fill="#8a4300">演示占位图 · ${width}×${height} · 未调用真实模型</text>
</svg>`;

  return { base64: toBase64(svg), mimeType: "image/svg+xml" };
}
