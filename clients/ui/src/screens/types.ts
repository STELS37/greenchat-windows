// clients/ui/src/screens/types.ts — wire shapes mirrored from the server REST API (T-405).
// The UI layer never imports server code; these interfaces restate the JSON the endpoints return so
// screens stay fully typed. Keep in sync with server/src/modules/{auth,users,chats,settings,contacts}.

// The minimal user identity echoed by register/login and cached for an instant cold-start header.
export interface AuthUser {
  id: number;
  username: string;
  name: string;
}

// POST /v1/auth/register and /v1/auth/login result (server: sessionPayload).
export interface AuthSession {
  user?: AuthUser;
  session_id: number;
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
}

// GET /v1/users/me — the owner's full profile (server: getMe).
export interface Me {
  id: number;
  username: string;
  name: string;
  bio: string;
  avatar_file_id: number | null;
  is_bot: boolean;
  // T-514 (§4): present+true for a service account. OPTIONAL/additive — absent on today's payloads.
  is_system?: boolean;
  phone: string | null;
  email: string | null;
  email_verified_at: number | null;
  locale: string;
  totp_enabled: boolean;
  emoji_status: string | null;
  emoji_status_until: number | null;
  birthday: string | null;
  timezone: string | null;
  // T-503 (BANKING §4): the user's chosen display currency (ISO-4217), source of truth for the "≈"
  // fiat approximations. null means "never chosen" -> the server treats it as USD, and the client may
  // offer a one-time locale-based suggestion (T-503 sub-task 4). Additive; set via PUT /v1/me/currency.
  display_currency: string | null;
  default_msg_ttl_sec: number;
  last_seen_at: number;
  created_at: number;
}

// One row of GET /v1/chats (server: ChatListEntry from buildChatList).
export interface ChatEntry {
  id: number;
  kind: string;
  title: string;
  username: string | null;
  photo_file_id: number | null;
  peer_is_bot?: boolean;
  // Additive list-only field. Older servers omit it; current servers expose the other dialog member
  // so recent conversations can populate participant pickers even when the explicit address book is empty.
  peer_user_id?: number | null;
  last_message: {
    id: number;
    sender_id: number | null;
    kind: string;
    text: string;
    created_at: number;
    // Server sends this only for kind='service' (see server/src/modules/chats.ts). It is what lets the
    // chat-list preview name the actual event instead of printing "Служебное сообщение" for all of them.
    service_event?: string | null;
    // Author label, sent only for a group/channel row with an ordinary last message. Absent for dialogs
    // (one possible author) and for service rows (no author) — and absent from older servers, so the
    // preview must stay correct without it.
    sender_name?: string;
  } | null;
  unread_count: number;
  muted_until: number;
  pinned: boolean;
  archived: boolean;
  my_role: string;
  message_ttl_sec: number;
  draft: string | null;
  updated_at: number;
}

// GET /v1/badge — the global unread summary (server: getBadge).
export interface Badge {
  total_unread: number;
  unread_chats: number;
  mentions: number;
}

// PUT /v1/chats/:id/settings result (server: putSettings).
export interface ChatSettings {
  chat_id: number;
  muted_until: number;
  pinned: boolean;
  archived: boolean;
}

// GET/PUT /v1/privacy — flat {key: value} map over the M0 privacy keys.
export type PrivacyMap = Record<string, string>;

// GET/PATCH /v1/users/me/settings — {settings:{...}} on the wire; this is the inner object.
export type SettingsMap = Record<string, unknown>;

// T-503 (BANKING §4/§6) — one "≈ amount currency" fiat approximation attached to a wallet balance or
// operation row. Restated here (the UI layer never imports clients/core); mirrors ApproxFiat in
// clients/core/src/types.ts and server buildApproxFiat. `amount` is a decimal STRING fed verbatim to
// Intl.NumberFormat so precision survives (never parsed to float). Shape (proven by live probe):
//   USD display / rate unavailable -> currency:"USD", rate_asof:null (unavailable:true only on G-004);
//   normal cross-rate             -> currency:<chosen>, rate_asof:<fetched_at>, stale flags age.
// The field is ABSENT (not null) when fx is off — the formatter then renders nothing.
export interface ApproxFiat {
  currency: string;
  amount: string;
  rate_asof: number | null;
  stale: boolean;
  unavailable?: boolean;
}

// ---- T-406: message feed wire shapes (server: serializeMessageRow, Appendix C.1) ----

// The author of a message: a real user, a deleted-account tombstone, an anonymous admin (posts AS the
// chat), or null for a service/system message.
export type MsgSender =
  | { id: number; username: string; name: string }
  | { id: number; deleted: true }
  | { id: number; anonymous: true }
  | null;

export interface MsgFile {
  id: number;
  name: string;
  mime: string;
  size: number;
  meta: Record<string, unknown> | null;
}

// Server-native stickers carry their physical PNG/WebP inside `message.sticker.file`, not in the
// top-level `message.file` field used by ordinary attachments. `meta` is optional because the sticker
// serializer intentionally exposes only stable file identity fields.
export interface MsgStickerFile {
  id: number;
  name: string;
  mime: string;
  size: number;
  meta?: Record<string, unknown> | null;
}

export interface MsgSticker {
  id: number;
  pack_id: number;
  emoji: string;
  pos?: number;
  file: MsgStickerFile | null;
}

// The quoted message under a reply — id + author + an 80-char preview (blanked when hidden/deleted).
export interface MsgReplyTo {
  id: number;
  sender_id: number | null;
  text: string;
}

// One reaction bucket: an emoji, its total count, and whether the viewer is in it.
export interface MsgReaction {
  emoji: string;
  count: number;
  me: boolean;
}

export type MsgInlineButton =
  | { text: string; callback_data: string; url?: never; mini_app?: never }
  | { text: string; url: string; callback_data?: never; mini_app?: never }
  | {
      text: string;
      mini_app: { app_id: number; start_param?: string };
      callback_data?: never;
      url?: never;
    };

export interface MsgReplyMarkup {
  inline_keyboard: MsgInlineButton[][];
}

// GET /v1/chats/:id/receipt-state — aggregate peer cursors used to restore bubble checks after
// reopening a conversation. Both values are monotonic message ids; zero means no visible receipt.
export interface ChatReceiptState {
  chat_id: number;
  delivered_up_to_message_id: number;
  read_up_to_message_id: number;
}

// A message as the history/events return it. Only the fields the feed renders are typed; the index
// signature keeps forward-compatibility with the many T-2xx fields we pass through untouched. A deleted
// message is the tombstone { id, deleted:true }, so every render field is optional beyond id/chat_id.
export interface Message {
  id: number;
  chat_id: number;
  sender?: MsgSender;
  kind?: string;
  text?: string;
  file?: MsgFile | null;
  sticker?: MsgSticker | null;
  reply_to?: MsgReplyTo | null;
  forward_from_user_id?: number | null;
  forward_from_chat_id?: number | null;
  forward_from_name?: string | null;
  service_event?: string | null;
  reactions?: MsgReaction[];
  reply_markup?: MsgReplyMarkup | null;
  edited_at?: number | null;
  deleted?: boolean;
  created_at?: number;
  silent?: boolean;
  parent_message_id?: number | null;
  reply_count?: number;
  // Present only on a local optimistic bubble (never sent by the server) — see PendingMessage.
  client_msg_id?: string;
  [k: string]: unknown;
}

// A row of GET /v1/chats/:id/members — the roster the composer's @mention autocomplete filters.
export interface ChatMember {
  id: number;
  username: string;
  name: string;
  is_bot?: boolean;
  avatar_file_id?: number | null;
  role?: string;
  custom_title?: string | null;
  anonymous?: boolean;
  rights?: Record<string, boolean>;
  restricted_until?: number | null;
}
