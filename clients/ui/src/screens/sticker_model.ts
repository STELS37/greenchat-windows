// clients/ui/src/screens/sticker_model.ts — pure wire parsing and ordering for the sticker tray.
// The server is authoritative, but the tray treats every payload as untrusted so a malformed pack can
// never turn the composer into a blank/broken panel.

export interface StickerFileView {
  id: number;
  name: string;
  mime: "image/webp" | "image/png";
  size: number;
}

export interface StickerView {
  id: number;
  packId: number;
  emoji: string;
  pos: number;
  file: StickerFileView;
}

export interface StickerPackView {
  id: number;
  slug: string;
  title: string;
  installed: boolean;
  stickers: StickerView[];
}

export interface StickerLibrary {
  recent: StickerView[];
  packs: StickerPackView[];
}

export interface StickerSection {
  key: string;
  title: string;
  marker: string;
  stickers: StickerView[];
  recent: boolean;
}

const STICKER_MIMES = new Set(["image/webp", "image/png"]);
const MAX_RECENT = 30;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function normalizeSticker(value: unknown): StickerView | null {
  const raw = record(value);
  if (!raw) return null;
  const fileRaw = record(raw.file);
  const id = positiveInt(raw.id);
  const packId = positiveInt(raw.pack_id);
  const fileId = positiveInt(fileRaw?.id);
  const size = Number(fileRaw?.size);
  const name = typeof fileRaw?.name === "string" ? fileRaw.name.trim() : "";
  const mime = typeof fileRaw?.mime === "string" ? fileRaw.mime.trim().toLowerCase() : "";
  if (!id || !packId || !fileId || !name || !STICKER_MIMES.has(mime)) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  const emoji = typeof raw.emoji === "string" ? raw.emoji.trim().slice(0, 16) : "";
  const posRaw = Number(raw.pos);
  return {
    id,
    packId,
    emoji,
    pos: Number.isInteger(posRaw) && posRaw >= 0 ? posRaw : 0,
    file: { id: fileId, name, mime: mime as StickerFileView["mime"], size },
  };
}

export function normalizeStickerPack(value: unknown): StickerPackView | null {
  const raw = record(value);
  if (!raw) return null;
  const id = positiveInt(raw.id);
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!id || !slug || !title) return null;
  const source = Array.isArray(raw.stickers) ? raw.stickers : [];
  const stickers = source
    .map(normalizeSticker)
    .filter((item): item is StickerView => item !== null && item.packId === id)
    .sort((a, b) => a.pos - b.pos || a.id - b.id);
  if (stickers.length === 0) return null;
  return { id, slug, title, installed: raw.installed === true, stickers };
}

function uniqueStickers(values: StickerView[], max = Number.POSITIVE_INFINITY): StickerView[] {
  const seen = new Set<number>();
  const out: StickerView[] = [];
  for (const sticker of values) {
    if (seen.has(sticker.id)) continue;
    seen.add(sticker.id);
    out.push(sticker);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeStickerLibrary(packsPayload: unknown, recentPayload: unknown): StickerLibrary {
  const packsRaw = record(packsPayload);
  const recentRaw = record(recentPayload);
  const packs = (Array.isArray(packsRaw?.packs) ? packsRaw.packs : [])
    .map(normalizeStickerPack)
    .filter((pack): pack is StickerPackView => pack !== null);
  const recent = uniqueStickers(
    (Array.isArray(recentRaw?.stickers) ? recentRaw.stickers : [])
      .map(normalizeSticker)
      .filter((sticker): sticker is StickerView => sticker !== null),
    MAX_RECENT,
  );
  return { packs, recent };
}

export function rememberRecent(recent: readonly StickerView[], picked: StickerView): StickerView[] {
  return uniqueStickers([picked, ...recent], MAX_RECENT);
}

export function stickerSections(library: StickerLibrary, recentTitle: string): StickerSection[] {
  const sections: StickerSection[] = [];
  if (library.recent.length > 0) {
    sections.push({
      key: "recent",
      title: recentTitle,
      marker: "🕘",
      stickers: library.recent,
      recent: true,
    });
  }
  for (const pack of library.packs) {
    sections.push({
      key: `pack:${pack.id}`,
      title: pack.title,
      marker: pack.stickers.find((s) => s.emoji)?.emoji || "▣",
      stickers: pack.stickers,
      recent: false,
    });
  }
  return sections;
}

export function stickerSendBody(stickerId: number, clientMessageId: string, replyToId: number | null): Record<string, unknown> {
  if (!Number.isInteger(stickerId) || stickerId <= 0) throw new Error("invalid sticker id");
  const client_msg_id = clientMessageId.trim();
  if (!client_msg_id) throw new Error("client message id required");
  const body: Record<string, unknown> = { sticker_id: stickerId, client_msg_id };
  if (replyToId !== null) body.reply_to_id = replyToId;
  return body;
}
