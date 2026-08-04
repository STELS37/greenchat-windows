// clients/ui/src/icons.ts — dependency-free GreenChat V4 icon system.
// Every glyph uses currentColor and the same rounded 1.8px stroke so navigation,
// finance, messaging and system actions stay visually consistent across all shells.

export type IconName =
  | "logo"
  | "chats"
  | "calls"
  | "wallet"
  | "exchange"
  | "cards"
  | "import"
  | "settings"
  | "devices"
  | "more"
  | "lock"
  | "logout"
  | "plus"
  | "search"
  | "help"
  | "back"
  | "chevron"
  | "close"
  | "check"
  | "refresh"
  | "pin"
  | "pinOff"
  | "bell"
  | "bellOff"
  | "archive"
  | "unarchive"
  | "shield"
  | "spark"
  | "layers"
  | "send"
  | "receive"
  | "swap"
  | "history"
  | "trend"
  | "copy"
  | "qr"
  | "user"
  | "users"
  | "phone"
  | "video"
  // Call-log direction arrows (V74). A call log answers "who called whom, and did it connect" at a
  // glance, and every mainstream client says it with an arrow rather than words: down-left = it came
  // in, up-right = I placed it, the same arrow with a broken tail = nobody spoke. Reusing the finance
  // send/receive glyphs would tie money iconography to calls, so these are their own 24px shapes on
  // the shared 1.8px rounded stroke.
  | "callIn"
  | "callOut"
  | "callMissed"
  | "mic"
  | "micOff"
  | "videoOff"
  | "camera"
  | "file"
  | "image"
  | "paperclip"
  | "attach"
  | "upload"
  | "smile"
  | "edit"
  | "trash"
  | "eye"
  | "eyeOff"
  | "info"
  | "warning"
  | "clock"
  | "globe"
  | "offline"
  | "reply"
  | "forward"
  | "play"
  | "pause"
  | "stop"
  | "download";

interface IconSpec {
  paths: string[];
  circles?: Array<[number, number, number]>;
  // Small solid dots (the "i" of info, the "?" of help, eyes, the warning bang). They must be FILLED
  // even inside an otherwise stroked glyph: a stroked circle of r≈1 renders as a ring, and drawing
  // them as zero-length path segments (the previous "M12 17h.01" trick) pins them to the stroke
  // width so they stop scaling with the icon.
  dots?: Array<[number, number, number]>;
  rects?: Array<[number, number, number, number, number?]>;
  polyline?: string[];
  // Solid glyphs. The stroke system is right for outline symbols, but a transport control
  // (play / pause / stop) reads as a mis-drawn outline unless it is filled — that is exactly
  // how the media surfaces ended up shipping bare "▶" / "❚❚" text characters instead.
  filled?: boolean;
  // Knock-out fill. A brand mark is a silhouette with holes (the three dots inside the bubble):
  // painting the holes with a colour would bind the mark to one background, so the holes are
  // sub-paths of the same outline and the even-odd rule cuts them out to whatever is behind.
  evenOdd?: boolean;
}

const PAPERCLIP_ICON: IconSpec = {
  paths: ["M13.234 20.252 21 12.3A6 6 0 0 0 12.51 3.81l-8.235 8.235a4 4 0 0 0 5.657 5.657l7.52-7.52a2 2 0 0 0-2.83-2.828l-7.52 7.52"],
};

const ICONS: Record<IconName, IconSpec> = {
  // The GreenChat mark. This is NOT a free drawing: it is the shipped identity — the Android launcher
  // icon, the maskable PWA icon, the favicon and the apple-touch icon all draw the same speech bubble
  // with three knocked-out dots (clients/web/public/icon.svg, 512 box). Until V78 the app rendered a
  // completely different glyph here (a stroked "G" with a leaf), so the mark on the home screen and
  // the mark inside the app were two different logos. The geometry below is icon.svg scaled by
  // 24/512 = 0.046875 so the two can never drift again; the dots are even-odd holes, not paint, so the
  // mark sits on any surface.
  logo: {
    filled: true,
    evenOdd: true,
    paths: [
      "M12 5.625c-3.891 0-7.031 2.578-7.031 5.766 0 1.828 1.031 3.469 2.672 4.5"
        + "l-.75 2.484 2.766-1.453c.703.141 1.5.234 2.344.234"
        + "c3.891 0 7.031-2.578 7.031-5.766S15.891 5.625 12 5.625Z"
        + "M8.435 11.391a.94.94 0 1 0 1.88 0 .94.94 0 1 0-1.88 0Z"
        + "M11.06 11.391a.94.94 0 1 0 1.88 0 .94.94 0 1 0-1.88 0Z"
        + "M13.685 11.391a.94.94 0 1 0 1.88 0 .94.94 0 1 0-1.88 0Z",
    ],
  },
  chats: {
    paths: [
      "M7.5 15.5 3.5 19v-5.35A6.5 6.5 0 0 1 9.5 3h3A6.5 6.5 0 0 1 19 9.5v.5a6.5 6.5 0 0 1-6.5 6.5h-5Z",
      "M7.5 8.75h9M7.5 12h6",
    ],
  },
  calls: {
    paths: [
      "M7.1 3.8 9.8 7a1.2 1.2 0 0 1-.1 1.6L8 10.2a15.8 15.8 0 0 0 5.8 5.8l1.6-1.7a1.2 1.2 0 0 1 1.6-.1l3.2 2.7a1.2 1.2 0 0 1 .3 1.5A4.5 4.5 0 0 1 16.4 21C9 20.5 3.5 15 3 7.6A4.5 4.5 0 0 1 5.6 3.5a1.2 1.2 0 0 1 1.5.3Z",
    ],
  },
  wallet: {
    paths: [
      "M4.5 6.5h13A2.5 2.5 0 0 1 20 9v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 2 18V6.5A2.5 2.5 0 0 1 4.5 4H17",
      "M15 11h5v5h-5a2.5 2.5 0 0 1 0-5Z",
    ],
    circles: [[16.5, 13.5, 0.45]],
  },
  exchange: {
    paths: ["M4 7h14", "m15 4 3 3-3 3", "M20 17H6", "m9 14-3 3 3 3"],
  },
  cards: {
    paths: [
      "M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z",
      "M3 9h18",
      "M7 15h4",
    ],
  },
  import: {
    paths: [
      "M12 3v11",
      "m8 10 4 4 4-4",
      "M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5",
    ],
  },
  settings: {
    paths: ["M4 7h10M18 7h2M4 17h2M10 17h10M4 12h4M12 12h8"],
    circles: [
      [16, 7, 2],
      [8, 17, 2],
      [10, 12, 2],
    ],
  },
  // Account devices: a desktop display and a phone in one compact outline. This is intentionally
  // separate from `phone` (a call handset) and `qr` (the linking action): the Settings row describes
  // the whole session/device inventory, not either transport by itself.
  devices: {
    rects: [[2.5, 4, 14, 10, 2], [14.5, 8, 7, 12, 1.8]],
    paths: ["M7 18h5M9.5 14v4", "M17 17.5h2"],
  },
  // Three dots drawn as zero-length stroked segments render at stroke-width (1.8 px) and read as
  // faint specks next to the 24 px outline glyphs of the neighbouring tabs. Filled circles give the
  // "more" tab the same visual weight as the rest of the rail.
  more: { paths: [], dots: [[5, 12, 1.75], [12, 12, 1.75], [19, 12, 1.75]] },
  lock: { paths: ["M6.5 10h11A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10Z", "M8 10V7a4 4 0 0 1 8 0v3", "M12 14.25v2.5"] },
  logout: { paths: ["M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4", "M14 8l4 4-4 4", "M9 12h9"] },
  plus: { paths: ["M12 5v14M5 12h14"] },
  search: { paths: ["m20 20-4.2-4.2"], circles: [[10.5, 10.5, 6.5]] },
  help: { paths: ["M9.6 9a2.55 2.55 0 1 1 4.35 1.8c-.95.93-1.95 1.3-1.95 2.7"], circles: [[12, 12, 9]], dots: [[12, 17.2, 1.05]] },
  back: { paths: ["m14.5 5-7 7 7 7", "M8 12h11"] },
  // A disclosure marker, not a navigation arrow: setting rows were reusing "back" rotated 180deg,
  // which draws a full arrow with a shaft where every platform draws a thin chevron.
  chevron: { paths: ["m9.5 5.5 6.5 6.5-6.5 6.5"] },
  close: { paths: ["M6 6l12 12M18 6 6 18"] },
  check: { paths: ["m5 12 4.2 4.2L19 6.5"] },
  refresh: { paths: ["M20 6v5h-5", "M4 18v-5h5", "M6.1 8.5A7 7 0 0 1 18.7 7L20 11", "M4 13l1.3 4A7 7 0 0 0 17.9 15.5"] },
  // Pin/unpin. The previous glyphs were four disconnected diagonal strokes that read as a scribble at
  // 20 px (V17: the pinned bar and the message menu both render this at icon size). These are the
  // closed silhouettes: a pin head, its neck and the needle — recognisable without any fill.
  pin: {
    paths: [
      "M12 17v5",
      "M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z",
    ],
  },
  pinOff: {
    paths: [
      "M12 17v5",
      "M15 9.3V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.9",
      "m2 2 20 20",
      "M9 9v1.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h11",
    ],
  },
  bell: { paths: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9", "M10 21h4"] },
  bellOff: { paths: ["M13.75 4.25A6 6 0 0 0 6 8c0 2.6-.4 4.1-1 5.2", "M18 8c0 4.25 1.1 5.9 2 7", "M3 3l18 18", "M10 21h4", "M6.8 17H3c0-.72.39-1.2.9-1.75"] },
  archive: { paths: ["M4 5h16v4H4z", "M6 9v10h12V9", "M10 13h4"] },
  unarchive: { paths: ["M4 5h16v4H4z", "M6 9v10h12V9", "m9 15 3-3 3 3", "M12 12v5"] },
  shield: { paths: ["M12 3 5.5 5.6v5.25c0 4.35 2.55 7.75 6.5 10.15 3.95-2.4 6.5-5.8 6.5-10.15V5.6L12 3Z", "m9.25 12 1.8 1.8 3.9-4.05"] },
  spark: { paths: ["m12 3 1.35 4.15L17.5 8.5l-4.15 1.35L12 14l-1.35-4.15L6.5 8.5l4.15-1.35L12 3Z", "m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z"] },
  layers: { paths: ["m12 3 9 5-9 5-9-5 9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"] },
  send: { paths: ["M21 3 9.5 14.5", "m21 3-7 18-4.5-6.5L3 10Z"] },
  receive: { paths: ["M12 3v13", "m7 11 5 5 5-5", "M5 21h14"] },
  // Call-log arrows: one diagonal shaft plus its head. "In" points down-left into the phone, "out"
  // points up-right away from it, and "missed" is the incoming arrow with a short dash across the
  // shaft — readable at 14px, which is the size the log row uses next to the outcome text.
  callIn: { paths: ["M17 7 8 16", "M8 10v6h6"] },
  callOut: { paths: ["M7 17 16 8", "M16 14V8h-6"] },
  callMissed: { paths: ["M17 7 8 16", "M8 10v6h6", "M15 15l4 4"] },
  swap: { paths: ["M7 7h12", "m16 4 3 3-3 3", "M17 17H5", "m8 14-3 3 3 3"] },
  history: { paths: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 7v5l3.5 2"] },
  trend: { paths: ["m4 17 5-5 4 3 7-8", "M15 7h5v5"] },
  copy: { rects: [[8, 8, 12, 12, 2], [4, 4, 12, 12, 2]], paths: [] },
  qr: { paths: ["M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z", "M14 14h2v2h-2zM18 14h2v6h-2zM14 18h2v2h-2z"] },
  user: { paths: ["M4 21a8 8 0 0 1 16 0"], circles: [[12, 7, 4]] },
  users: { paths: ["M3 21a7 7 0 0 1 14 0", "M16 4.5a3.5 3.5 0 0 1 0 7", "M18 14a6 6 0 0 1 4 5.6"], circles: [[10, 7, 4]] },
  phone: { paths: ["M7.1 3.8 9.8 7a1.2 1.2 0 0 1-.1 1.6L8 10.2a15.8 15.8 0 0 0 5.8 5.8l1.6-1.7a1.2 1.2 0 0 1 1.6-.1l3.2 2.7a1.2 1.2 0 0 1 .3 1.5A4.5 4.5 0 0 1 16.4 21C9 20.5 3.5 15 3 7.6A4.5 4.5 0 0 1 5.6 3.5a1.2 1.2 0 0 1 1.5.3Z"] },
  video: { paths: ["M4.5 6h10A2.5 2.5 0 0 1 17 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 2 15.5v-7A2.5 2.5 0 0 1 4.5 6Z", "m17 10 5-3v10l-5-3"] },
  mic: { paths: ["M8.5 5a3.5 3.5 0 0 1 7 0v7a3.5 3.5 0 0 1-7 0Z", "M5 11.5a7 7 0 0 0 14 0", "M12 18.5V22M8 22h8"] },
  // V75 — the two "off" states a live call needs. Same stroke language as their "on" twins plus the
  // universal diagonal cut, so a muted microphone reads as the SAME object turned off, not a new one.
  micOff: { paths: ["M8.5 8.4V5a3.5 3.5 0 0 1 6.9-.8", "M15.5 11.6V12a3.5 3.5 0 0 1-5 3.2", "M5 11.5a7 7 0 0 0 10.4 6.1M19 11.5a6.9 6.9 0 0 1-.9 3.4", "M12 18.5V22M8 22h8", "M3 3l18 18"] },
  videoOff: { paths: ["M14.4 6H4.5A2.5 2.5 0 0 0 2 8.5v7A2.5 2.5 0 0 0 4.5 18h9.9", "M17 10l5-3v10l-5-3", "M3 3l18 18"] },
  camera: { paths: ["M4.5 7h3l1.5-2h6l1.5 2h3A2.5 2.5 0 0 1 22 9.5v8A2.5 2.5 0 0 1 19.5 20h-15A2.5 2.5 0 0 1 2 17.5v-8A2.5 2.5 0 0 1 4.5 7Z"], circles: [[12, 13, 4]] },
  file: { paths: ["M6 2.5h8l5 5V21H6z", "M14 2.5V8h5", "M9 13h6M9 17h6"] },
  image: { paths: ["M4.5 4h15A2.5 2.5 0 0 1 22 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5v-11A2.5 2.5 0 0 1 4.5 4Z", "m3 17 5-5 4 4 2-2 5 5"], circles: [[16.5, 8.5, 1.5]] },
  // Attachment must read as a paperclip at a glance. The old upright three-loop outline looked like
  // a chain/link glyph in the 24px composer slot. A diagonal open clip matches the visual grammar of
  // established messengers and keeps both the generic `paperclip` and composer-facing `attach` names
  // on one canonical shape so the two cannot drift apart again.
  paperclip: PAPERCLIP_ICON,
  attach: PAPERCLIP_ICON,
  upload: { paths: ["M12 21V8", "m7 12 5-5 5 5", "M5 3h14"] },
  smile: { paths: ["M8.5 14.5a5 5 0 0 0 7 0"], circles: [[12, 12, 9]], dots: [[9, 9.2, 1.05], [15, 9.2, 1.05]] },
  edit: { paths: ["M4 20h4l11-11-4-4L4 16z", "m13-13 4 4"] },
  trash: { paths: ["M4 7h16", "M9 7V4h6v3", "m7 7 .7 10h8.6L17 7", "M10 11v5M14 11v5"] },
  eye: { paths: ["M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"], circles: [[12, 12, 2.5]] },
  eyeOff: { paths: ["M3 3l18 18", "M10.5 6.2A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a13.4 13.4 0 0 1-2.2 3", "M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6a10.5 10.5 0 0 0 3.1-.5"] },
  info: { paths: ["M12 11v6"], circles: [[12, 12, 9]], dots: [[12, 7.6, 1.05]] },
  warning: { paths: ["M10.3 4.2 2.5 18a2 2 0 0 0 1.75 3h15.5a2 2 0 0 0 1.75-3L13.7 4.2a2 2 0 0 0-3.4 0Z", "M12 9.5v4.5"], dots: [[12, 17.2, 1.05]] },
  clock: { paths: ["M12 7v5l3 2"], circles: [[12, 12, 9]] },
  globe: { paths: ["M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"], circles: [[12, 12, 9]] },
  // V76: "the server cannot be reached" needed its own symbol. Reusing `warning` for a dropped
  // connection told the same story as a server 500, and the two failures have different answers
  // (wait/retry vs. report). The globe with a stroke through it is the globe already in this set,
  // so the offline state stays visibly part of the same drawn family.
  offline: { paths: ["M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18", "M4 4l16 16"], circles: [[12, 12, 9]] },
  // Reply / forward are the two actions users look for first in a message menu. The plain "back"
  // arrow and the send paper-plane were standing in for them, which reads as a navigation control
  // rather than a reply — a curved arrow is the shape every messenger uses for this.
  reply: { paths: ["m9 7-5 5 5 5", "M4 12h9a5 5 0 0 1 5 5v2"] },
  forward: { paths: ["m15 7 5 5-5 5", "M20 12h-9a5 5 0 0 0-5 5v2"] },
  play: { paths: ["M9 6.2 18.4 12 9 17.8Z"], filled: true },
  pause: { paths: [], rects: [[8, 6, 3.2, 12, 1.4], [12.8, 6, 3.2, 12, 1.4]], filled: true },
  stop: { paths: [], rects: [[7, 7, 10, 10, 2.5]], filled: true },
  download: { paths: ["M12 4v10", "m7.5 11.5 4.5 4.5 4.5-4.5", "M5 20h14"] },
};

// Every registered name, so a test can render the whole registry instead of trusting that a glyph
// added to the union type also got real geometry.
export const ICON_NAMES = Object.keys(ICONS) as readonly IconName[];

const NS = "http://www.w3.org/2000/svg";

// Real browsers use the SVG namespace. Minimal test DOMs and a few embedded WebViews may expose only
// createElement; the fallback still produces a harmless, styled node instead of crashing the whole UI.
function svgNode<T extends Element>(tag: string): T {
  const doc = document as Document & { createElementNS?: (namespace: string, qualifiedName: string) => Element };
  return (typeof doc.createElementNS === "function"
    ? doc.createElementNS(NS, tag)
    : doc.createElement(tag)) as unknown as T;
}

export function icon(name: IconName, className = "gc-icon"): SVGSVGElement {
  const spec = ICONS[name];
  const svg = svgNode<SVGSVGElement>("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", spec.filled ? "currentColor" : "none");
  svg.setAttribute("stroke", spec.filled ? "none" : "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  if (spec.evenOdd) svg.setAttribute("fill-rule", "evenodd");

  for (const d of spec.paths) {
    const path = svgNode<SVGPathElement>("path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  for (const [cx, cy, r] of spec.circles ?? []) {
    const circle = svgNode<SVGCircleElement>("circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", String(r));
    svg.append(circle);
  }
  for (const [cx, cy, r] of spec.dots ?? []) {
    const dot = svgNode<SVGCircleElement>("circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", String(r));
    dot.setAttribute("fill", "currentColor");
    dot.setAttribute("stroke", "none");
    svg.append(dot);
  }
  for (const [x, y, width, height, radius] of spec.rects ?? []) {
    const rect = svgNode<SVGRectElement>("rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(height));
    if (radius !== undefined) rect.setAttribute("rx", String(radius));
    svg.append(rect);
  }
  for (const points of spec.polyline ?? []) {
    const polyline = svgNode<SVGPolylineElement>("polyline");
    polyline.setAttribute("points", points);
    svg.append(polyline);
  }
  return svg;
}
