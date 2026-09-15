// SPDX-License-Identifier: AGPL-3.0-or-later
import { el } from "../dom.ts";

export interface EpicLibraryPort { list(): Promise<Array<{ id: string; name: string }>>; launch(id: string): Promise<void> }
export function createEpicLibrary(locale: string, port?: EpicLibraryPort) {
  const copy = (a: string, b: string) => locale.startsWith("ru") ? a : b;
  const root = el("section", { class: "gc-epic-library" });
  const status = el("p", { role: "status", "aria-live": "polite" });
  const list = el("div", { class: "gc-epic-games" });
  const refresh = el("button", { type: "button", class: "gc-btn" }, [copy("Найти установленные игры", "Find installed games")]) as HTMLButtonElement;
  root.append(el("h2", {}, [copy("Epic Games на этом компьютере", "Epic Games on this computer")]),
    el("p", {}, [copy("Игры из Epic Games Launcher. Этот список не привязывает аккаунт Epic к GreenChat.",
      "Games installed through Epic Games Launcher. This list does not link your Epic account to GreenChat.")]), refresh, status, list);
  let destroyed = false;
  let busy = false;
  const load = async () => {
    if (destroyed || busy || !port) return;
    busy = true; refresh.disabled = true;
    list.replaceChildren(); status.textContent = copy("Поиск игр…", "Finding games…");
    try {
      const games = await port.list();
      if (destroyed) return;
      if (!Array.isArray(games) || games.length > 1000 || games.some(g => !g || typeof g.name !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(g.id))) throw new Error("Invalid inventory");
      status.textContent = games.length ? "" : copy("Установленные игры Epic не найдены.", "No installed Epic games found.");
      for (const game of games) {
        const launch = el("button", { type: "button", class: "gc-btn" }, [copy("Играть", "Play")]) as HTMLButtonElement;
        launch.addEventListener("click", async () => {
          if (destroyed || launch.disabled) return;
          launch.disabled = true;
          try { await port.launch(game.id); if (!destroyed) status.textContent = copy("Запуск передан Epic Games Launcher.", "Launch request sent to Epic Games Launcher."); }
          catch { if (!destroyed) status.textContent = copy("Не удалось открыть игру. Проверьте Epic Games Launcher и обновите список.", "Could not open the game. Check Epic Games Launcher and refresh the list."); }
          finally { if (!destroyed) launch.disabled = false; }
        });
        list.append(el("article", { class: "gc-epic-game" }, [el("strong", {}, [game.name]), launch]));
      }
    } catch { if (!destroyed) status.textContent = copy("Не удалось прочитать список игр Epic.", "Could not read the Epic games list."); }
    finally { busy = false; if (!destroyed) refresh.disabled = false; }
  };
  refresh.addEventListener("click", () => { void load(); });
  if (!port) { refresh.disabled = true; status.textContent = copy("Доступно в обновлённом клиенте GreenChat для Windows.", "Available in the updated GreenChat Windows client."); }
  return { root, destroy() { destroyed = true; root.remove(); } };
}
