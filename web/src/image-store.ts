import { newId } from "./util";

/**
 * Generated images live in their own IndexedDB store, not inside the
 * conversation record.
 *
 * A single 1024x1024 PNG is a few hundred kilobytes; keeping them inline would
 * make every conversation save rewrite megabytes and would eventually hit the
 * localStorage/IndexedDB write limits. Messages only carry an image id.
 */

export interface StoredImage {
  id: string;
  /** WebP (or the original format when conversion is not possible). */
  blob: Blob;
  width: number;
  height: number;
  /** Bytes after compression, for the UI hint. */
  bytes: number;
  createdAt: number;
}

const DB_NAME = "cf-chat";
const STORE_NAME = "images";
const MAX_EDGE = 1536;
const WEBP_QUALITY = 0.9;

let storePromise: Promise<import("idb-keyval").UseStore> | null = null;

async function imageStore(): Promise<import("idb-keyval").UseStore> {
  if (!storePromise) {
    storePromise = import("idb-keyval").then(({ createStore }) =>
      createStore(DB_NAME, STORE_NAME),
    );
  }
  return storePromise;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Fall through to the <img> path for formats the decoder rejects.
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败。"));
    };
    image.src = url;
  });
}

/**
 * Re-encodes to WebP and caps the long edge.
 *
 * Providers hand back PNG, which is lossless and therefore large. WebP at 0.9
 * is visually indistinguishable at these sizes and roughly a tenth of the
 * bytes, which matters because everything is stored in the browser.
 */
async function compress(
  blob: Blob,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await decode(blob);
  const width = "width" in bitmap ? bitmap.width : 0;
  const height = "height" in bitmap ? bitmap.height : 0;
  if (!width || !height) return { blob, width: 0, height: 0 };

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) return { blob, width, height };
  context.drawImage(bitmap as CanvasImageSource, 0, 0, targetWidth, targetHeight);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  const encoded = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), "image/webp", WEBP_QUALITY);
  });

  // A failed encode (or a browser without WebP) keeps the original bytes.
  if (!encoded || encoded.size === 0) return { blob, width, height };
  return { blob: encoded, width: targetWidth, height: targetHeight };
}

/** Stores one generated image and returns its id plus final dimensions. */
export async function saveImage(
  base64: string,
  mimeType: string,
): Promise<{ id: string; width: number; height: number; bytes: number }> {
  const bytes = base64ToBytes(base64);
  const original = new Blob([bytes], { type: mimeType || "image/png" });
  const { blob, width, height } = await compress(original);

  const record: StoredImage = {
    id: newId(),
    blob,
    width,
    height,
    bytes: blob.size,
    createdAt: Date.now(),
  };

  const { set } = await import("idb-keyval");
  await set(record.id, record, await imageStore());
  return { id: record.id, width, height, bytes: record.bytes };
}

const urlCache = new Map<string, string>();

/** Returns an object URL for a stored image, cached for the page's lifetime. */
export async function imageUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return cached;

  try {
    const { get } = await import("idb-keyval");
    const record = await get<StoredImage>(id, await imageStore());
    if (!record?.blob) return null;
    const url = URL.createObjectURL(record.blob);
    urlCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

export async function imageRecord(id: string): Promise<StoredImage | null> {
  try {
    const { get } = await import("idb-keyval");
    return (await get<StoredImage>(id, await imageStore())) ?? null;
  } catch {
    return null;
  }
}

export async function deleteImages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    const url = urlCache.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urlCache.delete(id);
    }
  }
  try {
    const { delMany } = await import("idb-keyval");
    await delMany(ids, await imageStore());
  } catch {
    // Storage unavailable; the records are orphaned but harmless.
  }
}

/**
 * Drops image records no conversation refers to any more.
 *
 * Deleting a conversation removes its messages but not the blobs, so this runs
 * once at startup to keep the store from growing without bound.
 */
export async function pruneImages(keep: Set<string>): Promise<void> {
  try {
    const { keys, delMany } = await import("idb-keyval");
    const store = await imageStore();
    const all = await keys<string>(store);
    const orphans = all.filter((key) => !keep.has(key));
    if (orphans.length === 0) return;
    await delMany(orphans, store);
  } catch {
    // Nothing to clean up, or storage is unavailable.
  }
}

/** Triggers a browser download for a stored image. */
export async function downloadImage(id: string, filename: string): Promise<void> {
  const record = await imageRecord(id);
  if (!record) return;
  const url = URL.createObjectURL(record.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
