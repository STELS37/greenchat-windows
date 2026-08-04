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

const MAX_AVATAR_BYTES = 25 * 1024 * 1024;

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
 * Keep the initials already inside `target` as a no-network fallback and layer the real image over
 * them after a signed URL is minted. `set()` is race-safe: a late response for an older photo cannot
 * overwrite a newer selection.
 */
export function bindAvatarImage(
  target: HTMLElement,
  api: Pick<ApiLike, "get">,
  initialFileId: number | null,
  alt = "",
): AvatarImageBinding {
  let generation = 0;
  let image: HTMLImageElement | null = null;
  let destroyed = false;

  const clearImage = (): void => {
    image?.remove();
    image = null;
    target.classList.remove("has-image");
  };

  const set = async (fileId: number | null): Promise<void> => {
    const mine = ++generation;
    if (destroyed) return;
    if (!Number.isSafeInteger(fileId) || (fileId ?? 0) <= 0) {
      clearImage();
      return;
    }
    try {
      const signed = await api.get<{ url: string; expires_at: number }>(`/v1/files/${fileId}/url`);
      if (destroyed || mine !== generation || typeof signed.url !== "string" || !signed.url) return;
      const next = el("img", {
        class: "gc-avatar-photo",
        src: signed.url,
        alt,
        draggable: "false",
        decoding: "async",
      }) as HTMLImageElement;
      image?.remove();
      image = next;
      target.append(next);
      target.classList.add("has-image");
    } catch {
      // Initials remain visible. Avatar fetches are cosmetic and must never block the surrounding list.
      if (!destroyed && mine === generation) clearImage();
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
