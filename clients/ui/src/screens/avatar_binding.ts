import { el } from "../dom.ts";
import type { ApiLike } from "./api.ts";
import type { AvatarImageBinding } from "./avatar_media.ts";

interface AvatarImageCandidate {
  image: HTMLImageElement;
  release(): void;
}

interface AvatarSource {
  src: string;
  release(): void;
  invalidate?(): void;
}

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

async function avatarSource(fileId: number, src: string, signal: AbortSignal): Promise<AvatarSource> {
  if (!crossOriginHttpSource(src)) return { src, release() {} };
  const native = await import("./avatar_native.ts");
  return native.acquireNativeAvatar(fileId, src, signal);
}

/** The heavy image/network state machine is lazy-loaded after initials are already paintable. */
export function createAvatarImageBinding(
  target: HTMLElement,
  api: Pick<ApiLike, "get" | "resolveUrl">,
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

  const loadCandidate = async (fileId: number, src: string): Promise<AvatarImageCandidate | null> => {
    const controller = new AbortController();
    let cancelled = false;
    let settleImage: ((result: AvatarImageCandidate | null) => void) | null = null;
    let source: AvatarSource = { src: "", release() {} };

    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      if (settleImage) settleImage(null);
      else source.release();
    };
    cancelPending?.();
    cancelPending = cancel;

    try {
      source = await avatarSource(fileId, src, controller.signal);
      if (cancelled) {
        source.release();
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
            source.release();
          }
          resolve(result);
        };
        const onLoad = (): void => finish({ image: next, release: source.release });
        const onError = (): void => { source.invalidate?.(); finish(null); };
        settleImage = finish;

        next.addEventListener("load", onLoad);
        next.addEventListener("error", onError);
        target.append(next);
        next.setAttribute("src", source.src);
      });
    } catch {
      source.release();
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
    if (typeof fileId !== "number" || !Number.isSafeInteger(fileId) || fileId <= 0) {
      clearImage();
      return;
    }

    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
      try {
        const signed = await api.get<{ url: string; expires_at: number }>(`/v1/files/${fileId}/url`);
        if (destroyed || mine !== generation || typeof signed.url !== "string" || !signed.url.trim()) return;
        const candidate = await loadCandidate(fileId, resolvedUrl(signed.url.trim(), attempt));
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

  return {
    set,
    destroy() {
      destroyed = true;
      generation += 1;
      clearImage();
    },
  };
}
