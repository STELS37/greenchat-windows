// SPDX-License-Identifier: AGPL-3.0-or-later
import { el } from "../dom.ts";
import { tiktokPost } from "./tiktok_model.ts";

export function createSocialScreen(deps: { locale: string; onBack(): void }) {
  const ru = deps.locale.startsWith("ru");
  const copy = (a: string, b: string) => ru ? a : b;
  const root = el("section", { class: "gc-social-page" });
  const back = el("button", { type: "button", class: "gc-btn" }, [copy("Назад", "Back")]);
  back.addEventListener("click", deps.onBack);
  const form = el("form", { class: "gc-social-form" });
  const input = el("input", { type: "url", required: "", "aria-label": copy("Ссылка на видео TikTok", "TikTok post link"),
    placeholder: "https://www.tiktok.com/@name/video/…", class: "gc-input" }) as HTMLInputElement;
  const submit = el("button", { type: "submit", class: "gc-btn" }, [copy("Смотреть", "Watch")]);
  const status = el("p", { role: "status", "aria-live": "polite" });
  const feed = el("div", { class: "gc-social-posts" });
  form.append(input, submit);
  root.append(back, el("h1", {}, [copy("Социальная лента", "Social feed")]),
    el("h2", {}, ["TikTok"]), el("p", {}, [copy(
      "Вставь полную ссылку на публичное видео или фото TikTok. Плеер загрузится с TikTok после нажатия «Смотреть».",
      "Paste the full link to a public TikTok video or photo. The TikTok player loads when you select Watch.")]),
    form, status, feed);
  let frame: HTMLIFrameElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  const stopTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const onMessage = (event: MessageEvent) => {
    if (destroyed || !frame || event.origin !== "https://www.tiktok.com" || event.source !== frame.contentWindow ||
        event.data?.["x-tiktok-player"] !== true) return;
    if (event.data.type === "onPlayerReady") { stopTimer(); status.textContent = ""; }
    else if (event.data.type === "onPlayerError") {
      stopTimer(); status.textContent = copy("TikTok не смог показать публикацию. Она может быть удалена или недоступна в вашем регионе.",
        "TikTok could not display this post. It may be deleted or unavailable in your region.");
    }
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    if (destroyed) return;
    try {
      const post = tiktokPost(input.value);
      stopTimer();
      frame?.remove();
      frame = el("iframe", { title: "TikTok", src: post.playerUrl, class: "gc-social-player",
        allow: "fullscreen", referrerpolicy: "no-referrer",
        sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" }) as HTMLIFrameElement;
      const remove = el("button", { type: "button", class: "gc-btn" }, [copy("Закрыть видео", "Close video")]);
      remove.addEventListener("click", () => { stopTimer(); frame?.remove(); frame = null; feed.replaceChildren(); status.textContent = ""; });
      const original = el("a", { href: post.url, target: "_blank", rel: "noopener noreferrer", class: "gc-btn" }, [copy("Открыть в TikTok", "Open on TikTok")]);
      original.addEventListener("click", event => {
        const open = (window as Window & { __gcOpenTikTokPost?: (url: string) => Promise<void> }).__gcOpenTikTokPost;
        if (open) { event.preventDefault(); void open(post.url).catch(() => { if (!destroyed) status.textContent = copy("Не удалось открыть браузер.", "Could not open the browser."); }); }
      });
      feed.replaceChildren(frame, original, remove);
      status.textContent = copy("Загрузка TikTok…", "Loading TikTok…");
      timer = setTimeout(() => { if (!destroyed) status.textContent = copy(
        "TikTok долго не отвечает. Проверьте доступность сервиса и ссылку.", "TikTok is taking too long to respond. Check service availability and the link."); }, 20_000);
    } catch {
      status.textContent = copy("Нужна полная ссылка вида https://www.tiktok.com/@имя/video/номер. Короткие ссылки сначала откройте в браузере.",
        "Use a full https://www.tiktok.com/@name/video/id link. Open shortened links in your browser first.");
    }
  };
  form.addEventListener("submit", onSubmit);
  window.addEventListener("message", onMessage);
  const visibility = () => {
    if (document.visibilityState === "hidden") frame?.contentWindow?.postMessage({ "x-tiktok-player": true, type: "pause" }, "https://www.tiktok.com");
  };
  document.addEventListener("visibilitychange", visibility);
  return { root, destroy() { destroyed = true; stopTimer(); window.removeEventListener("message", onMessage);
    document.removeEventListener("visibilitychange", visibility);
    form.removeEventListener("submit", onSubmit); frame?.remove(); frame = null; root.remove(); } };
}
