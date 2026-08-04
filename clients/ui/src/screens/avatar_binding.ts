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

interface SignedAvatarUrl {
  url: string;
  expires_at: number;
}

interface SignedAvatarLease extends SignedAvatarUrl {
  generation: number;
}

type SignedUrlCacheEntry = {
  generation: number;
  value?: SignedAvatarLease;
  pending?: Promise<SignedAvatarLease>;
};

// A single chat list can paint the same person in several surfaces, and rapid live-list paints may
// briefly create overlapping bindings. Coalesce the signed-URL lookup per ApiLike instance so those
// harmless UI lifecycles can never turn into hundreds of /v1/files/:id/url requests.
let signedUrlCaches = new WeakMap<object, Map<number, SignedUrlCacheEntry>>();
const SIGNED_URL_SKEW_SEC = 15;

function signedUrlCache(api: object): Map<number, SignedUrlCacheEntry> {
  let cache = signedUrlCaches.get(api);
  if (!cache) {
    cache = new Map();
    signedUrlCaches.set(api, cache);
  }
  return cache;
}

function signedUrlStillValid(value: SignedAvatarUrl): boolean {
  return Number.isFinite(value.expires_at) && value.expires_at > Math.floor(Date.now() / 1000) + SIGNED_URL_SKEW_SEC;
}

async function acquireSignedAvatarUrl(
  api: Pick<ApiLike, "get" | "resolveUrl">,
  fileId: number,
  failedGeneration: number | null,
): Promise<SignedAvatarLease> {
  const cache = signedUrlCache(api as object);
  const existing = cache.get(fileId);

  // A retry refreshes only the generation that actually failed. If forty rows fail the same shared
  // blob concurrently, the first row advances the generation and every other row joins that one
  // refresh instead of deleting/restarting it (the production request storm's sharp edge).
  if (failedGeneration !== null && existing && existing.generation !== failedGeneration) {
    if (existing.value && signedUrlStillValid(existing.value)) return existing.value;
    if (existing.pending) return existing.pending;
  } else if (failedGeneration === null) {
    if (existing?.value && signedUrlStillValid(existing.value)) return existing.value;
    if (existing?.pending) return existing.pending;
  }

  const generation = (existing?.generation ?? 0) + 1;
  const entry: SignedUrlCacheEntry = { generation };
  const pending = api.get<SignedAvatarUrl>(`/v1/files/${fileId}/url`).then((value) => {
    if (typeof value?.url !== "string" || !value.url.trim()) throw new Error("AVATAR_URL_REQUIRED");
    const normalized: SignedAvatarLease = {
      url: value.url.trim(),
      expires_at: Number(value.expires_at),
      generation,
    };
    if (cache.get(fileId) === entry) {
      delete entry.pending;
      entry.value = normalized;
    }
    return normalized;
  }, (error: unknown) => {
    if (cache.get(fileId) === entry) cache.delete(fileId);
    throw error;
  });
  entry.pending = pending;
  cache.set(fileId, entry);
  return pending;
}

function httpAvatarSource(src: string): boolean {
  try {
    const here = globalThis.location;
    if (!here || typeof here.href !== "string" || !here.href) return false;
    const target = new URL(src, here.href);
    return target.protocol === "http:" || target.protocol === "https:";
  } catch {
    return false;
  }
}

async function avatarSource(fileId: number, src: string, signal: AbortSignal): Promise<AvatarSource> {
  // Use the bounded blob cache on the web too. The file endpoint is intentionally `no-store`; feeding
  // every recycled row directly into <img src=/f/...> therefore re-downloaded the same avatar and, in
  // a render loop, exhausted the shared API bucket. One validated blob per file is both safer and much
  // cheaper; initials remain the fallback if the fetch or decode fails.
  if (!httpAvatarSource(src)) return { src, release() {} };
  const native = await import("./avatar_native.ts");
  return native.acquireNativeAvatar(fileId, src, signal);
}

/** Test-only reset for deterministic request-coalescing assertions. */
export function resetAvatarBindingCacheForTests(): void {
  signedUrlCaches = new WeakMap<object, Map<number, SignedUrlCacheEntry>>();
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

    let signedGeneration: number | null = null;
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
      try {
        const signed = await acquireSignedAvatarUrl(api, fileId, attempt > 0 ? signedGeneration : null);
        signedGeneration = signed.generation;
        if (destroyed || mine !== generation) return;
        const candidate = await loadCandidate(fileId, resolvedUrl(signed.url, attempt));
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
