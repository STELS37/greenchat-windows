// Native shells render the shared UI from a local WebView origin while avatar bytes live on the
// selected GreenChat HTTPS origin. Keep that transport out of the initial web bundle: avatar_media
// imports this module only for a cross-origin HTTP(S) URL.
export interface NativeAvatarSource {
  src: string;
  release(): void;
  invalidate(): void;
}

const MAX_AVATAR_BYTES = 25 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ITEMS = 96;
const blobs = new Map<string, Blob>();
const pending = new Map<string, Promise<Blob>>();
let cachedBytes = 0;

function cacheKey(fileId: number, src: string): string {
  try {
    const url = new URL(src, globalThis.location?.href);
    return `${url.origin}${url.pathname}#${fileId}`;
  } catch {
    return `${src.split("?", 1)[0]}#${fileId}`;
  }
}

function remember(key: string, blob: Blob): void {
  const previous = blobs.get(key);
  if (previous) cachedBytes -= previous.size;
  blobs.delete(key);
  blobs.set(key, blob);
  cachedBytes += blob.size;
  while (blobs.size > MAX_CACHE_ITEMS || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = blobs.entries().next().value as [string, Blob] | undefined;
    if (!oldest) break;
    blobs.delete(oldest[0]);
    cachedBytes -= oldest[1].size;
  }
}

function cached(key: string): Blob | null {
  const blob = blobs.get(key);
  if (!blob) return null;
  blobs.delete(key);
  blobs.set(key, blob);
  return blob;
}

async function download(fileId: number, src: string): Promise<{ blob: Blob; key: string }> {
  const key = cacheKey(fileId, src);
  const hit = cached(key);
  if (hit) return { blob: hit, key };
  const existing = pending.get(key);
  if (existing) return { blob: await existing, key };
  const request = globalThis.fetch(src, {
    method: "GET",
    credentials: "omit",
    cache: "force-cache",
    redirect: "error",
    referrerPolicy: "no-referrer",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`AVATAR_DOWNLOAD_${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) throw new Error("AVATAR_TOO_LARGE");
    const blob = await response.blob();
    const mime = (blob.type || response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (blob.size <= 0 || blob.size > MAX_AVATAR_BYTES || !mime.startsWith("image/") || mime.includes("svg")) {
      throw new Error("AVATAR_IMAGE_REQUIRED");
    }
    remember(key, blob);
    return blob;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return { blob: await request, key };
}

export async function acquireNativeAvatar(fileId: number, src: string, signal: AbortSignal): Promise<NativeAvatarSource> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const { blob, key } = await download(fileId, src);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const objectUrl = URL.createObjectURL(blob);
  let live = true;
  return {
    src: objectUrl,
    release() {
      if (!live) return;
      live = false;
      URL.revokeObjectURL(objectUrl);
    },
    invalidate() {
      if (blobs.get(key) === blob) {
        blobs.delete(key);
        cachedBytes -= blob.size;
      }
    },
  };
}

export function resetNativeAvatarCacheForTests(): void {
  blobs.clear();
  pending.clear();
  cachedBytes = 0;
}
