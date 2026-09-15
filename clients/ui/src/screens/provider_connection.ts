// SPDX-License-Identifier: AGPL-3.0-or-later
import { el } from "../dom.ts";
import type { ApiLike } from "./api.ts";

export type AccountProvider = "epic" | "tiktok";
export interface ProviderConnectionState {
  available: boolean;
  account: { id: string; name: string } | null;
}
export function providerBase(provider: AccountProvider): string {
  return provider === "epic" ? "/v1/gaming/connect/epic" : "/v1/social/connect/tiktok";
}
export function providerAuthorizationUrl(raw: string, provider: AccountProvider): string {
  const url = new URL(raw);
  const host = provider === "epic" ? "www.epicgames.com" : "www.tiktok.com";
  const path = provider === "epic" ? "/id/authorize" : "/v2/auth/authorize/";
  if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== path ||
      url.username || url.password || url.port || url.hash || url.searchParams.get("response_type") !== "code" ||
      !url.searchParams.get("state")) throw new Error("Invalid authorization URL");
  return url.href;
}
export function createProviderConnection(deps: {
  provider: AccountProvider; locale: string; api: ApiLike;
  openExternal?(url: string): Promise<void> | void;
  onChange?(state: ProviderConnectionState | null): void;
}) {
  const ru = deps.locale.startsWith("ru");
  const copy = (a: string, b: string) => ru ? a : b;
  const name = deps.provider === "epic" ? "Epic Games" : "TikTok";
  const base = providerBase(deps.provider);
  const root = el("div", { class: "gc-provider-connection" });
  const status = el("p", { role: "status", "aria-live": "polite" });
  const connect = el("button", { type: "button", class: "gc-btn" }, [copy("Подключить", "Connect")]) as HTMLButtonElement;
  const refresh = el("button", { type: "button", class: "gc-btn" }, [copy("Проверить подключение", "Check connection")]) as HTMLButtonElement;
  root.append(status, connect, refresh);
  let state: ProviderConnectionState | null = null;
  let busy = false;
  let destroyed = false;
  let waiting = false;
  function paint(message?: string) {
    status.textContent = message ?? (state?.account ? `${copy("Подключён", "Connected")}: ${state.account.name}`
      : waiting ? copy(`Завершите вход в ${name} в браузере.`, `Finish signing in to ${name} in your browser.`)
      : state?.available ? copy(`Войдите в ${name}, чтобы подтвердить свой аккаунт.`, `Sign in to ${name} to verify your account.`)
      : copy(`Подключение ${name} ещё не настроено на сервере.`, `${name} connection has not been configured on this server yet.`));
    connect.textContent = state?.account ? copy("Отключить", "Disconnect") : copy("Подключить", "Connect");
    connect.disabled = busy || !state || (!state.available && !state.account);
    refresh.disabled = busy;
  }
  async function read() {
    const next = await deps.api.get<ProviderConnectionState>(`${base}/status`);
    if (!next || typeof next.available !== "boolean" || !(next.account === null ||
        (typeof next.account?.id === "string" && !!next.account.id && typeof next.account.name === "string"))) {
      throw new Error("Invalid connection state");
    }
    if (destroyed) return;
    state = next;
    if (next.account) waiting = false;
    deps.onChange?.(next);
  }
  async function run(action: () => Promise<void>) {
    if (busy || destroyed) return;
    busy = true; paint(copy("Проверка…", "Checking…"));
    try { await action(); if (!destroyed) { busy = false; paint(); } }
    catch { if (!destroyed) { busy = false; state = null; deps.onChange?.(null);
      paint(copy("Не удалось проверить подключение. Повторите попытку.", "Could not verify the connection. Try again.")); } }
  }
  connect.addEventListener("click", () => { void run(async () => {
    if (state?.account) {
      await deps.api.delete(`${base}/connection`); waiting = false;
    } else {
      const result = await deps.api.post<{ url: string }>(`${base}/start`);
      if (destroyed) return;
      const url = providerAuthorizationUrl(result.url, deps.provider);
      const native = (window as Window & { __gcOpenProviderAuthorization?: (url: string) => Promise<void> }).__gcOpenProviderAuthorization;
      if (deps.openExternal) await deps.openExternal(url);
      else if (native) await native(url);
      else window.open(url, "_blank", "noopener,noreferrer");
      waiting = true;
    }
    await read();
  }); });
  const wake = () => { if (document.visibilityState !== "hidden") void run(read); };
  refresh.addEventListener("click", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);
  const timer = setInterval(wake, 30_000);
  void run(read);
  return { root, destroy() { destroyed = true; clearInterval(timer);
    window.removeEventListener("focus", wake); window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake); root.remove(); } };
}
