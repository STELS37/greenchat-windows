// clients/ui/src/screens/support_faq.ts — T-514 (MS-4 §3.1.3): the static, localised FAQ shown in
// Settings → Help. Pure/DOM-free: it only turns a fixed, ordered list of ids into resolved (question,
// answer) strings via the i18n catalogue, so a unit test can assert every entry is actually translated
// (a missing key would leak the raw key as the text). The DOM accordion lives in support_help.ts.
import type { I18n } from "../i18n.ts";

// 5–10 questions (SUPPORT.md §3.1.3). Order = display order. Each id maps to faq.q.<id> / faq.a.<id>.
export const FAQ_IDS = [
  "delivery",
  "diagnostics",
  "ticket_vs_report",
  "report",
  "selfhost",
  "notifications",
  "data",
] as const;

export type FaqId = (typeof FAQ_IDS)[number];

export interface FaqEntry {
  id: FaqId;
  q: string;
  a: string;
}

// Resolve the FAQ to localized (question, answer) pairs in display order.
export function faqEntries(i18n: I18n): FaqEntry[] {
  return FAQ_IDS.map((id) => ({ id, q: i18n.t(`faq.q.${id}`), a: i18n.t(`faq.a.${id}`) }));
}
