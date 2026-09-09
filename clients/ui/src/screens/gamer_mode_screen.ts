// SPDX-License-Identifier: AGPL-3.0-or-later
import "./gamer_mode_screen.css";

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
  if (className) el.className = className;
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

const safeImg = (url?: string | null): HTMLImageElement | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url, globalThis.location?.href ?? "https://greenchat.invalid/");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const img = node("img", "gc-gm-media");
    img.src = parsed.href;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    return img;
  } catch {
    return null;
  }
};

export function createGamerModeScreen(deps: GamerModeScreenDeps): GamerModeScreen {
  const copy = (deps.locale ?? "ru").toLowerCase().startsWith("ru") ? ru : en;
  const root = node("section", "gc-gm");
  root.setAttribute("aria-label", copy.title);
  root.dataset.enabled = deps.initialEnabled === false ? "false" : "true";

  const ambient = node("div", "gc-gm-ambient");
  ambient.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 22; i += 1) {
    const p = node("i", "gc-gm-particle");
    p.style.setProperty("--i", String(i));
    ambient.append(p);
  }
  root.append(ambient);

  const shell = node("div", "gc-gm-shell");
  const header = node("header", "gc-gm-header");
  const intro = node("div", "gc-gm-intro");
  const mark = node("div", "gc-gm-mark", "G");
  const titles = node("div");
  titles.append(node("h1", "gc-gm-title", copy.title), node("p", "gc-gm-subtitle", copy.subtitle));
  intro.append(mark, titles);

  const toggleLabel = node("label", "gc-gm-switch-wrap");
  const toggleCopy = node("span", "gc-gm-switch-copy");
  toggleCopy.append(node("b", "", copy.title), node("small", "", root.dataset.enabled === "true" ? "ON" : "OFF"));
  const toggle = node("input") as HTMLInputElement;
  toggle.type = "checkbox";
  toggle.checked = root.dataset.enabled === "true";
  toggle.className = "gc-gm-switch-input";
  const visual = node("span", "gc-gm-switch");
  toggleLabel.append(toggleCopy, toggle, visual);
  const onToggle = (): void => {
    root.dataset.enabled = toggle.checked ? "true" : "false";
    toggleCopy.querySelector("small")!.textContent = toggle.checked ? "ON" : "OFF";
    deps.onEnabledChange?.(toggle.checked);
  };
  toggle.addEventListener("change", onToggle);
  header.append(intro, toggleLabel);

  const hero = node("div", "gc-gm-hero");
  const profileCard = node("article", "gc-gm-card gc-gm-profile");
  const avatar = node("div", "gc-gm-avatar");
  const avatarImg = safeImg(deps.profile.avatarUrl);
  if (avatarImg) avatar.append(avatarImg);
  else avatar.append(node("span", "gc-gm-avatar-fallback", (deps.profile.name.trim()[0] || "G").toUpperCase()));
  avatar.append(node("span", "gc-gm-online-dot"));
  const profileText = node("div", "gc-gm-profile-copy");
  profileText.append(node("h2", "", deps.profile.name), node("p", "", deps.profile.username ? `@${deps.profile.username}` : "GreenChat Gamer"));
  profileCard.append(avatar, profileText);

  const now = node("article", "gc-gm-card gc-gm-now");
  now.append(node("div", "gc-gm-section-kicker", copy.now));
  if (deps.profile.nowPlaying) {
    const media = safeImg(deps.profile.nowPlaying.imageUrl);
    if (media) now.append(media);
    const body = node("div", "gc-gm-now-copy");
    body.append(node("h3", "", deps.profile.nowPlaying.title));
    if (deps.profile.nowPlaying.subtitle) body.append(node("p", "", deps.profile.nowPlaying.subtitle));
    if (deps.profile.nowPlaying.session) body.append(node("span", "gc-gm-pill", deps.profile.nowPlaying.session));
    now.append(body);
  } else {
    now.append(node("div", "gc-gm-empty", "—"));
  }
  hero.append(profileCard, now);

  const grid = node("div", "gc-gm-grid");
  const makeProvider = (kind: "steam" | "faceit" | "epic"): HTMLElement => {
    const card = node("article", `gc-gm-card gc-gm-provider gc-gm-provider-${kind}`);
    const top = node("div", "gc-gm-provider-top");
    const logo = node("div", "gc-gm-provider-logo", kind === "steam" ? "S" : kind === "faceit" ? "F" : "E");
    const name = kind === "steam" ? copy.steam : kind === "faceit" ? copy.faceit : copy.epic;
    const linked = kind === "steam" ? Boolean(deps.profile.steam?.linked) : kind === "faceit" ? Boolean(deps.profile.faceit?.linked) : true;
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
      card.append(stats, button(copy.open, deps.onOpenSteam));
    } else if (kind === "faceit") {
      const f = deps.profile.faceit;
      const level = Math.max(1, Math.min(10, Number(f?.level ?? 1)));
      const rank = node("div", "gc-gm-faceit-rank");
      rank.append(node("div", "gc-gm-faceit-badge", String(level)), node("div", "gc-gm-faceit-copy", `${copy.elo}: ${f?.elo ?? "—"}`));
      if (f?.topPercent != null) rank.append(node("span", "gc-gm-pill", `${copy.top} ${f.topPercent}%`));
      const bar = node("div", "gc-gm-level-bar");
      for (let i = 1; i <= 10; i += 1) {
        const dot = node("span", `gc-gm-level-dot${i <= level ? " is-on" : ""}`, String(i));
        bar.append(dot);
      }
      card.append(rank, bar, button(copy.open, deps.onOpenFaceit));
    } else {
      card.append(node("p", "gc-gm-provider-hint", "Игровая библиотека и друзья Epic Games."), button(copy.open, deps.onOpenEpic));
    }
    return card;
  };
  grid.append(makeProvider("steam"), makeProvider("faceit"), makeProvider("epic"));

  const achievements = node("article", "gc-gm-card gc-gm-achievements");
  achievements.append(node("div", "gc-gm-section-kicker", copy.achievements));
  const achievementsGrid = node("div", "gc-gm-achievements-grid");
  const source = deps.profile.achievements?.slice(0, 4) ?? [];
  const items = source.length ? source : [
    { title: copy.calm, subtitle: copy.calmHint, icon: "✦" },
    { title: copy.particles, subtitle: copy.particlesHint, icon: "❄" },
  ];
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
      root.remove();
    },
  };
}
