// Avatar/photo primitives shared by Settings, chat list and chat info. Initials are always paintable
// immediately; the image state machine is a lazy chunk so a broken network can never block the screen.
import type { ApiLike } from "./api.ts";
import type { MediaPort, UploadedFile } from "./media.ts";

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

const AVATAR_TEXT = {
  change: ["Изменить фото", "Change photo"],
  invalid: ["Выберите изображение JPG, PNG, WebP, HEIC или GIF", "Choose a JPG, PNG, WebP, HEIC, or GIF image"],
  tooLarge: ["Изображение должно быть не больше 25 МБ", "The image must be no larger than 25 MB"],
  requests: ["Заявки на вступление", "Join requests"],
  approve: ["Принять", "Approve"],
  deny: ["Отклонить", "Decline"],
  empty: ["Новых заявок нет", "No pending requests"],
  pending: ["Загрузка заявок…", "Loading requests…"],
} as const;

export function avatarText(locale: string, key: keyof typeof AVATAR_TEXT): string {
  return AVATAR_TEXT[key][locale.toLowerCase().startsWith("ru") ? 0 : 1];
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
  return media.upload(bytes, { name: file.name || "avatar", mime });
}

/**
 * Keep the monogram in `target` until a decoded photo is ready. The full binding is loaded after the
 * first paint; rapid set/destroy calls are revision-guarded while that chunk is resolving.
 */
export function bindAvatarImage(
  target: HTMLElement,
  api: Pick<ApiLike, "get" | "resolveUrl">,
  initialFileId: number | null,
  alt = "",
): AvatarImageBinding {
  let revision = 0;
  let destroyed = false;
  let real: AvatarImageBinding | null = null;
  const ready = import("./avatar_binding.ts").then(({ createAvatarImageBinding }) => {
    if (destroyed) return null;
    real = createAvatarImageBinding(target, api, alt);
    return real;
  }, () => null);
  const set = async (fileId: number | null): Promise<void> => {
    const mine = ++revision;
    const binding = await ready;
    if (!binding || destroyed || mine !== revision) return;
    await binding.set(fileId);
  };
  void set(initialFileId);
  return {
    set,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      revision += 1;
      real?.destroy();
    },
  };
}
