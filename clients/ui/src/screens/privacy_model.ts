// clients/ui/src/screens/privacy_model.ts — the M0 privacy keys, mirrored from the server (T-405).
// Source of truth: server/src/modules/contacts.ts PRIVACY_DEFAULTS + the per-key value domains. Every
// key here must exist there; the plan requires the screen to cover ALL M0 privacy keys. DOM-free →
// unit-tested against the exact key set. GET/PUT /v1/privacy carry a flat {key: value} map.
import type { PrivacyMap } from "./types.ts";

// scope = everyone|contacts|nobody · reach = everyone|contacts · toggle = on|off.
export type PrivacyKind = "scope" | "reach" | "toggle";

export interface PrivacyItem {
  key: string;
  kind: PrivacyKind;
  def: string;
}

const SCOPE_OPTIONS = ["everyone", "contacts", "nobody"] as const;
const REACH_OPTIONS = ["everyone", "contacts"] as const;
const TOGGLE_OPTIONS = ["on", "off"] as const;

// Order = how the screen lists them; def/kind copied verbatim from PRIVACY_DEFAULTS.
export const PRIVACY_ITEMS: PrivacyItem[] = [
  { key: "last_seen", kind: "scope", def: "everyone" },
  { key: "profile_photo", kind: "scope", def: "everyone" },
  { key: "birthday", kind: "scope", def: "contacts" },
  { key: "group_invite", kind: "scope", def: "everyone" },
  { key: "find_by_name", kind: "scope", def: "everyone" },
  { key: "find_by_phone", kind: "scope", def: "contacts" },
  { key: "find_by_email", kind: "scope", def: "contacts" },
  { key: "calls", kind: "scope", def: "everyone" },
  { key: "who_can_message", kind: "reach", def: "everyone" },
  { key: "read_receipts", kind: "toggle", def: "on" },
  { key: "typing_indicator", kind: "toggle", def: "on" },
  { key: "forward_privacy", kind: "toggle", def: "off" },
];

const BY_KEY = new Map(PRIVACY_ITEMS.map((i) => [i.key, i]));

export function privacyOptions(kind: PrivacyKind): readonly string[] {
  if (kind === "reach") return REACH_OPTIONS;
  if (kind === "toggle") return TOGGLE_OPTIONS;
  return SCOPE_OPTIONS;
}

export function privacyDefault(key: string): string {
  return BY_KEY.get(key)?.def ?? "everyone";
}

// Fill a possibly-partial server map with defaults for any missing key and drop unknown keys, so the
// screen always renders exactly the M0 key set with a defined value per row.
export function normalizePrivacy(raw: PrivacyMap): PrivacyMap {
  const out: PrivacyMap = {};
  for (const item of PRIVACY_ITEMS) {
    const v = raw[item.key];
    out[item.key] = typeof v === "string" ? v : item.def;
  }
  return out;
}
