export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function truncateTitle(text: string, max = 26): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "新对话";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Runs at most once per interval, always with the latest arguments. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, wait = 80): (...args: A) => void {
  let timer: number | null = null;
  let pending: A | null = null;

  return (...args: A) => {
    pending = args;
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      if (next) fn(...next);
    }, wait);
  };
}

export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;

  const date = new Date(timestamp);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function shortModelName(model: string): string {
  if (!model) return "默认模型";
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}
