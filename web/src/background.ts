const BACKGROUND_KEY = "cf-chat:background:v1";
const MAX_EDGE = 1920;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function loadBackgroundImage(): Promise<string | null> {
  try {
    const { get } = await import("idb-keyval");
    const stored = await get<string>(BACKGROUND_KEY);
    return typeof stored === "string" && stored.startsWith("data:image/") ? stored : null;
  } catch {
    return null;
  }
}

export async function saveBackgroundImage(dataUrl: string | null): Promise<void> {
  const { set, del } = await import("idb-keyval");
  if (dataUrl) await set(BACKGROUND_KEY, dataUrl);
  else await del(BACKGROUND_KEY);
}

async function toBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path for formats the decoder rejects.
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败，请换一张试试。"));
    };
    image.src = url;
  });
}

/** Downscales an uploaded image so it can live in IndexedDB without bloating the page. */
export async function prepareBackground(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
  if (file.size > MAX_FILE_BYTES) throw new Error("图片太大，请控制在 15 MB 以内。");

  const bitmap = await toBitmap(file);
  const width = "width" in bitmap ? bitmap.width : 0;
  const height = "height" in bitmap ? bitmap.height : 0;
  if (!width || !height) throw new Error("图片尺寸无法识别。");

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法处理这张图片。");
  context.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  const webp = canvas.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
}

/** Paints the image behind the app; `dim` is the veil strength in percent. */
export function applyBackground(dataUrl: string | null, dim: number): void {
  const body = document.body;
  if (!dataUrl) {
    body.classList.remove("has-bg");
    body.style.removeProperty("--bg-image");
    return;
  }
  body.classList.add("has-bg");
  body.style.setProperty("--bg-image", `url("${dataUrl}")`);
  body.style.setProperty("--veil", `${Math.min(90, Math.max(0, dim))}%`);
}
