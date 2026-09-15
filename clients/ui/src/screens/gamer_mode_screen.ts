// SPDX-License-Identifier: AGPL-3.0-or-later

export interface GamerModeProfile {
  name: string;
  username?: string;
  avatarUrl?: string | null;
  steam?: {
    linked: boolean;
    displayName?: string;
    avatarUrl?: string | null;
    level?: number | null;
    games?: number | null;
    hours?: number | null;
    friends?: number | null;
  };
  faceit?: {
    linked: boolean;
    level?: number | null;
    elo?: number | null;
    topPercent?: number | null;
  };
  epic?: { linked: boolean };
  nowPlaying?: {
    title: string;
    subtitle?: string;
    imageUrl?: string | null;
    session?: string | null;
  } | null;
  achievements?: ReadonlyArray<{ title: string; subtitle?: string; icon?: string }>;
}

export interface GamerModeScreenDeps {
  profile: GamerModeProfile;
  locale?: string;
  initialEnabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  onOpenSteam?: () => void;
  onOpenFaceit?: () => void;
  onOpenEpic?: () => void;
  epicConnection?: HTMLElement;
  onBack?: () => void;
  onUnlinkSteam?: () => void;
  onUnlinkFaceit?: () => void;
  busy?: boolean;
  available?: boolean;
}

export interface GamerModeScreen {
  root: HTMLElement;
  destroy(): void;
}

const ru = {
  title: "Игровой режим",
  subtitle: "Твой игровой профиль. Игры, достижения и друзья — в одном месте.",
  now: "Сейчас играет",
  achievements: "Достижения",
  steam: "Steam",
  faceit: "FACEIT",
  epic: "Epic Games",
  connected: "Подключено",
  notConnected: "Не подключено",
  open: "Открыть профиль",
  link: "Подключить",
  unlink: "Отключить",
  back: "Назад",
  epicHint: "Привязка Epic Games пока недоступна на сервере. Можно открыть магазин.",
  store: "Открыть Epic Games",
  empty: "Нет данных",
  noAchievements: "Достижения пока недоступны",
  level: "Уровень",
  games: "Игр",
  hours: "Часов",
  friends: "Друзей",
  elo: "ELO",
  top: "Топ",
  calm: "Плавные анимации",
  calmHint: "Мягкие переходы, карточки и фон без резких скачков.",
  particles: "Живой фон",
  particlesHint: "Лёгкие частицы подстраиваются под тему GreenChat.",
};
const en: Record<keyof typeof ru, string> = {
  title: "Gamer Mode",
  subtitle: "Your gaming profile. Games, achievements and friends in one place.",
  now: "Now playing",
  achievements: "Achievements",
  steam: "Steam",
  faceit: "FACEIT",
  epic: "Epic Games",
  connected: "Connected",
  notConnected: "Not connected",
  open: "Open profile",
  link: "Connect",
  unlink: "Disconnect",
  back: "Back",
  epicHint: "Epic Games linking is not available on this server yet. You can open the store.",
  store: "Open Epic Games",
  empty: "No data",
  noAchievements: "Achievements are not available yet",
  level: "Level",
  games: "Games",
  hours: "Hours",
  friends: "Friends",
  elo: "ELO",
  top: "Top",
  calm: "Smooth motion",
  calmHint: "Soft transitions, cards and background without harsh jumps.",
  particles: "Living background",
  particlesHint: "Subtle particles adapt to the GreenChat theme.",
};

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (className) el.setAttribute("class", className);
  if (text !== undefined) el.textContent = text;
  return el;
};

const button = (label: string, onClick?: () => void): HTMLButtonElement => {
  const b = node("button", "gc-gm-btn", label);
  b.type = "button";
  if (!onClick) b.disabled = true;
  else b.addEventListener("click", onClick);
  return b;
};

const safeImg = (url: string | null | undefined, cleanup: Array<() => void>): HTMLImageElement | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url, globalThis.location?.href ?? "https://greenchat.invalid/");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const img = node("img", "gc-gm-media");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    // Desktop CSP accepts blob images, while signed media lives on the configured backend.
    // Fetch only GreenChat's media route; provider credentials never travel to image hosts.
    if (parsed.origin !== globalThis.location?.origin && parsed.pathname.startsWith("/v1/gaming/media/")) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let objectUrl: string | null = null;
      cleanup.push(() => { controller.abort(); clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); });
      void fetch(parsed.href, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal })
        .then(async response => {
          if (!response.ok || !/^image\/(png|jpeg|webp)$/.test(response.headers.get("content-type")?.split(";")[0] ?? "")) return;
          if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024) return;
          const blob = await response.blob();
          if (controller.signal.aborted || blob.size > 2 * 1024 * 1024) return;
          objectUrl = URL.createObjectURL(blob);
          img.src = objectUrl;
        }).catch(() => { /* The surrounding profile/game text remains available without artwork. */ })
        .finally(() => clearTimeout(timeout));
    } else img.src = parsed.href;
    return img;
  } catch {
    return null;
  }
};

export function createGamerModeScreen(deps: GamerModeScreenDeps): GamerModeScreen {
  const cleanup: Array<() => void> = [];
  const copy = (deps.locale ?? "ru").toLowerCase().startsWith("ru") ? ru : en;
  const root = node("section", "gc-gm");
  root.setAttribute("aria-label", copy.title);
  root.dataset.enabled = deps.initialEnabled === false ? "false" : "true";

  const ambient = node("div", "gc-gm-ambient");
  ambient.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 22; i += 1) {
    const p = node("i", "gc-gm-particle");
    p.style.setProperty("--i", String(i));
    p.style.setProperty("--x", String((i * 47) % 101));
    ambient.append(p);
  }
  root.append(ambient);

  const shell = node("div", "gc-gm-shell");
  if (deps.onBack) shell.append(button(copy.back, deps.onBack));
  const header = node("header", "gc-gm-header");
  const intro = node("div", "gc-gm-intro");
  const mark = node("div", "gc-gm-mark", "G");
  const titles = node("div");
  titles.append(node("h1", "gc-gm-title", copy.title), node("p", "gc-gm-subtitle", copy.subtitle));
  intro.append(mark, titles);

  const toggleLabel = node("label", "gc-gm-switch-wrap");
  const toggleCopy = node("span", "gc-gm-switch-copy");
  const toggleState = node("small", "", root.dataset.enabled === "true" ? "ON" : "OFF");
  toggleCopy.append(node("b", "", copy.title), toggleState);
  const toggle = node("input") as HTMLInputElement;
  toggle.type = "checkbox";
  toggle.checked = root.dataset.enabled === "true";
  toggle.setAttribute("class", "gc-gm-switch-input");
  toggle.setAttribute("aria-label", copy.title);
  toggle.disabled = Boolean(deps.busy) || deps.available === false;
  const visual = node("span", "gc-gm-switch");
  toggleLabel.append(toggleCopy, toggle, visual);
  const onToggle = (): void => {
    root.dataset.enabled = toggle.checked ? "true" : "false";
    toggleState.textContent = toggle.checked ? "ON" : "OFF";
    deps.onEnabledChange?.(toggle.checked);
  };
  toggle.addEventListener("change", onToggle);
  header.append(intro, toggleLabel);

  const hero = node("div", "gc-gm-hero");
  const profileCard = node("article", "gc-gm-card gc-gm-profile");
  const avatar = node("div", "gc-gm-avatar");
  const avatarImg = safeImg(deps.profile.avatarUrl, cleanup);
  if (avatarImg) avatar.append(avatarImg);
  else avatar.append(node("span", "gc-gm-avatar-fallback", (deps.profile.name.trim()[0] || "G").toUpperCase()));
  avatar.append(node("span", "gc-gm-online-dot"));
  const profileText = node("div", "gc-gm-profile-copy");
  profileText.append(node("h2", "", deps.profile.name), node("p", "", deps.profile.username ? `@${deps.profile.username}` : "GreenChat Gamer"));
  profileCard.append(avatar, profileText);

  const now = node("article", "gc-gm-card gc-gm-now");
  now.append(node("div", "gc-gm-section-kicker", copy.now));
  if (deps.profile.nowPlaying) {
    const media = safeImg(deps.profile.nowPlaying.imageUrl, cleanup);
    if (media) now.append(media);
    const body = node("div", "gc-gm-now-copy");
    body.append(node("h3", "", deps.profile.nowPlaying.title));
    if (deps.profile.nowPlaying.subtitle) body.append(node("p", "", deps.profile.nowPlaying.subtitle));
    if (deps.profile.nowPlaying.session) body.append(node("span", "gc-gm-pill", deps.profile.nowPlaying.session));
    now.append(body);
  } else {
    now.append(node("div", "gc-gm-empty", copy.empty));
  }
  hero.append(profileCard, now);

  const grid = node("div", "gc-gm-grid");
  const makeProvider = (kind: "steam" | "faceit" | "epic"): HTMLElement => {
    const card = node("article", `gc-gm-card gc-gm-provider gc-gm-provider-${kind}`);
    const top = node("div", "gc-gm-provider-top");
    const logo = node("div", "gc-gm-provider-logo", kind === "steam" ? "S" : kind === "faceit" ? "F" : "E");
    const name = kind === "steam" ? copy.steam : kind === "faceit" ? copy.faceit : copy.epic;
    const linked = Boolean(deps.profile[kind]?.linked);
    const status = node("span", `gc-gm-status ${linked ? "is-linked" : ""}`, linked ? copy.connected : copy.notConnected);
    top.append(logo, node("h3", "", name), status);
    card.append(top);

    if (kind === "steam") {
      const s = deps.profile.steam;
      const stats = node("div", "gc-gm-stats");
      [[copy.level, s?.level], [copy.games, s?.games], [copy.hours, s?.hours], [copy.friends, s?.friends]].forEach(([label, value]) => {
        const item = node("div", "gc-gm-stat");
        item.append(node("strong", "", value == null ? "—" : String(value)), node("span", "", String(label)));
        stats.append(item);
      });
      card.append(stats, button(linked ? copy.open : copy.link, deps.onOpenSteam));
      if (linked && deps.onUnlinkSteam) card.append(button(copy.unlink, deps.onUnlinkSteam));
    } else if (kind === "faceit") {
      const f = deps.profile.faceit;
      const level = Number.isFinite(f?.level) ? Math.max(0, Math.min(10, Number(f!.level))) : 0;
      const rank = node("div", "gc-gm-faceit-rank");
      rank.style.setProperty("--rank-color", level >= 10 ? "#ff3425" : level >= 8 ? "#ff8a22" : level >= 4 ? "#f3d130" : level ? "#31c878" : "#93ab9c");
      rank.append(node("div", "gc-gm-faceit-badge", level ? String(level) : "—"), node("div", "gc-gm-faceit-copy", `${copy.elo}: ${f?.elo ?? "—"}`));
      if (f?.topPercent != null) rank.append(node("span", "gc-gm-pill", `${copy.top} ${f.topPercent}%`));
      const bar = node("div", "gc-gm-level-bar");
      for (let i = 1; i <= 10; i += 1) {
        const dot = node("span", `gc-gm-level-dot${i <= level ? " is-on" : ""}`, String(i));
        bar.append(dot);
      }
      card.append(rank, bar, button(linked ? copy.open : copy.link, deps.onOpenFaceit));
      if (linked && deps.onUnlinkFaceit) card.append(button(copy.unlink, deps.onUnlinkFaceit));
    } else {
      if (deps.epicConnection) card.append(deps.epicConnection);
      else card.append(node("p", "gc-gm-provider-hint", copy.epicHint), button(copy.store, deps.onOpenEpic));
    }
    return card;
  };
  grid.append(makeProvider("steam"), makeProvider("faceit"), makeProvider("epic"));

  const achievements = node("article", "gc-gm-card gc-gm-achievements");
  achievements.append(node("div", "gc-gm-section-kicker", copy.achievements));
  const achievementsGrid = node("div", "gc-gm-achievements-grid");
  const source = deps.profile.achievements?.slice(0, 4) ?? [];
  const items = source.length ? source : [{ title: copy.noAchievements, icon: "☆" }];
  for (const a of items) {
    const item = node("div", "gc-gm-achievement");
    item.append(node("span", "gc-gm-achievement-icon", a.icon ?? "★"));
    const text = node("div");
    text.append(node("strong", "", a.title));
    if (a.subtitle) text.append(node("small", "", a.subtitle));
    item.append(text);
    achievementsGrid.append(item);
  }
  achievements.append(achievementsGrid);

  shell.append(header, hero, grid, achievements);
  root.append(shell);

  let destroyed = false;
  return {
    root,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      toggle.removeEventListener("change", onToggle);
      for (const dispose of cleanup) dispose();
      root.remove();
    },
  };
}
