// Avatar/photo primitives shared by Settings, chat list and chat info. Display uses the server's
// short-lived signed media URL so an <img> never needs an Authorization header; uploads keep using the
// existing MediaPort/FileUploader pipeline, including retry/progress and the encrypted client cache.
import type { ApiLike } from "./api.ts";
import type { MediaPort, UploadedFile } from "./media.ts";
import { el } from "../dom.ts";

export type AvatarUploadPort = Pick<MediaPort, "upload">;

export interface AvatarFileLike {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AvatarImageBinding {
  set(fileId: number | null): Promise<void>;
  destroy(): void;
}

interface AvatarImageCandidate {
  image: HTMLImageElement;
  release(): void;
}

interface AvatarSource {
  src: string;
  release(): void;
}

const MAX_AVATAR_BYTES = 25 * 1024 * 1024;

function crossOriginHttpSource(src: string): boolean {
  try {
    const here = globalThis.location;
    if (!here || typeof here.href !== "string" || !here.href) return false;
    const target = new URL(src, here.href);
    return (target.protocol === "http:" || target.protocol === "https:") && target.origin !== here.origin;
  } catch {
    return false;
  }
}

async function cspSafeAvatarSource(src: string, signal: AbortSignal): Promise<AvatarSource> {
  // The desktop shell deliberately permits only self/data/blob in img-src. Signed media is served by
  // the selected GreenChat HTTPS origin, which is cross-origin from tauri:// / http://tauri.localhost.
  // Fetching it under connect-src + the server's exact CORS allowlist, then rendering a private blob
  // URL, keeps that strict CSP instead of opening img-src to arbitrary internet hosts. Web same-origin
  // avatars stay on the browser's normal image/cache path.
  if (!crossOriginHttpSource(src)) return { src, release() {} };

  const response = await globalThis.fetch(src, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`AVATAR_DOWNLOAD_${response.status}`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_AVATAR_BYTES) throw new Error("AVATAR_TOO_LARGE");

  const blob = await response.blob();
  const mime = (blob.type || response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (blob.size <= 0 || blob.size > MAX_AVATAR_BYTES || !mime.startsWith("image/") || mime.includes("svg")) {
    throw new Error("AVATAR_IMAGE_REQUIRED");
  }
  const objectUrl = URL.createObjectURL(blob);
  let live = true;
  return {
    src: objectUrl,
    release() {
      if (!live) return;
      live = false;
      URL.revokeObjectURL(objectUrl);
    },
  };
}

export function avatarText(locale: string, key: "change" | "invalid" | "tooLarge" | "requests" | "approve" | "deny" | "empty" | "pending"): string {
  const ru = locale.toLowerCase().startsWith("ru");
  const strings = ru
    ? {
        change: "Изменить фото",
        invalid: "Выберите изображение JPG, PNG, WebP, HEIC или GIF",
        tooLarge: "Изображение должно быть не больше 25 МБ",
        requests: "Заявки на вступление",
        approve: "Принять",
        deny: "Отклонить",
        empty: "Новых заявок нет",
        pending: "Загрузка заявок…",
      }
    : {
        change: "Change photo",
        invalid: "Choose a JPG, PNG, WebP, HEIC, or GIF image",
        tooLarge: "The image must be no larger than 25 MB",
        requests: "Join requests",
        approve: "Approve",
        deny: "Decline",
        empty: "No pending requests",
        pending: "Loading requests…",
      };
  return strings[key];
}

/** Validate and upload one profile/chat image through the canonical resumable uploader. */
export async function uploadAvatarFile(file: AvatarFileLike, media: AvatarUploadPort): Promise<UploadedFile> {
  const mime = file.type.trim().toLowerCase();
  if (file.size <= 0 || !mime.startsWith("image/") || mime.includes("svg")) {
    throw new Error("AVATAR_IMAGE_REQUIRED");
  }
  if (file.size > MAX_AVATAR_BYTES) throw new Error("AVATAR_TOO_LARGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size && file.size > 0) throw new Error("AVATAR_READ_FAILED");
  return media.upload(bytes, {
    name: file.name || "avatar",
    mime,
  });
}

/**
 * Keep the initials already inside `target` as the zero-network fallback. A candidate image stays
 * hidden until the browser has decoded enough bytes to fire `load`; a broken/blocked URL therefore
 * never paints an empty disc over the initials. Native shells resolve `/f/...` against the API origin,
 * and a transient blob-fetch failure gets one fresh signed-URL retry.
 */
export function bindAvatarImage(
  target: HTMLElement,
  api: Pick<ApiLike, "get" | "resolveUrl">,
  initialFileId: number | null,
  alt = "",
): AvatarImageBinding {
  const MAX_LOAD_ATTEMPTS = 2;
  let generation = 0;
  let image: HTMLImageElement | null = null;
  let imageRelease: (() => void) | null = null;
  let cancelPending: (() => void) | null = null;
  let destroyed = false;

  const clearImage = (): void => {
    cancelPending?.();
    cancelPending = null;
    image?.remove();
    image = null;
    imageRelease?.();
    imageRelease = null;
    target.classList.remove("has-image");
  };

  const resolvedUrl = (raw: string, attempt: number): string => {
    const absolute = api.resolveUrl?.(raw) ?? raw;
    if (attempt === 0) return absolute;
    return `${absolute}${absolute.includes("?") ? "&" : "?"}gc_avatar_retry=${attempt}`;
  };

  const loadCandidate = async (src: string): Promise<AvatarImageCandidate | null> => {
    const controller = new AbortController();
    let cancelled = false;
    let settleImage: ((result: AvatarImageCandidate | null) => void) | null = null;
    let releaseSource: () => void = () => {};

    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      if (settleImage) settleImage(null);
      else releaseSource();
    };
    cancelPending?.();
    cancelPending = cancel;

    try {
      const source = await cspSafeAvatarSource(src, controller.signal);
      releaseSource = source.release;
      if (cancelled) {
        releaseSource();
        return null;
      }

      return await new Promise((resolve) => {
        const next = el("img", {
          class: "gc-avatar-photo",
          alt,
          draggable: "false",
          decoding: "async",
          loading: "eager",
          hidden: true,
        }) as HTMLImageElement;
        let settled = false;

        const finish = (result: AvatarImageCandidate | null): void => {
          if (settled) return;
          settled = true;
          next.removeEventListener("load", onLoad);
          next.removeEventListener("error", onError);
          settleImage = null;
          if (!result) {
            next.remove();
            releaseSource();
          }
          resolve(result);
        };
        const onLoad = (): void => finish({ image: next, release: releaseSource });
        const onError = (): void => finish(null);
        settleImage = finish;

        next.addEventListener("load", onLoad);
        next.addEventListener("error", onError);
        target.append(next);
        next.setAttribute("src", source.src);
      });
    } catch {
      releaseSource();
      return null;
    } finally {
      if (cancelPending === cancel) cancelPending = null;
    }
  };

  const set = async (fileId: number | null): Promise<void> => {
    const mine = ++generation;
    cancelPending?.();
    cancelPending = null;
    if (destroyed) return;
    if (!Number.isSafeInteger(fileId) || (fileId ?? 0) <= 0) {
      clearImage();
      return;
    }

    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
      try {
        const signed = await api.get<{ url: string; expires_at: number }>(`/v1/files/${fileId}/url`);
        if (destroyed || mine !== generation || typeof signed.url !== "string" || !signed.url.trim()) return;
        const candidate = await loadCandidate(resolvedUrl(signed.url.trim(), attempt));
        if (destroyed || mine !== generation) {
          candidate?.image.remove();
          candidate?.release();
          return;
        }
        if (!candidate) continue;

        candidate.image.hidden = false;
        image?.remove();
        imageRelease?.();
        image = candidate.image;
        imageRelease = candidate.release;
        target.classList.add("has-image");
        return;
      } catch {
        return;
      }
    }
  };

  void set(initialFileId);
  return {
    set,
    destroy() {
      destroyed = true;
      generation += 1;
      clearImage();
    },
  };
}
