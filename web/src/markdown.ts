import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

/** Renders Markdown to sanitized HTML. Safe to call on partial output while streaming. */
export function renderMarkdown(source: string): string {
  if (!source) return "";
  try {
    const html = marked.parse(source, { async: false }) as string;
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  } catch {
    return DOMPurify.sanitize(source);
  }
}

/** Opens links in a new tab without leaking the opener. */
export function decorateLinks(root: HTMLElement): void {
  for (const anchor of root.querySelectorAll("a")) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
}
