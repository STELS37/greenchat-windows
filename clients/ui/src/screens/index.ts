// clients/ui/src/screens/index.ts — barrel for the T-405 screens layer. The web shell imports the app
// factory + Session from here; the pure models/helpers are re-exported for tests and other shells.
export { createApp } from "./app.ts";
export type { App, AppDeps, CallShell, ConferenceShell } from "./app.ts";

export { Session } from "./session.ts";
export type {
  TokenHolder, PersistedSession, SessionStorage, SessionDeps, RegisterFields, LoginFields, LocalData,
} from "./session.ts";

export { createAuthScreen } from "./auth_screen.ts";
export type { AuthScreenDeps, RegistrationMode, RegistrationModePort } from "./auth_screen.ts";
export { createChatListScreen } from "./chat_list_screen.ts";
export type { ChatListDeps } from "./chat_list_screen.ts";
export { createSettingsScreen } from "./settings_screen.ts";
export type { SettingsScreenDeps, DiagnosticsConsentPort } from "./settings_screen.ts";

export { createTelegramSettings } from "./telegram_settings.ts";
export type {
  TelegramAccountSyncView,
  TelegramAccountView,
  TelegramConnectionPort,
  TelegramConnectionView,
  TelegramLoginView,
  TelegramSettingsDeps,
  TelegramSettingsView,
} from "./telegram_settings.ts";
export { createServerScreen } from "./server_screen.ts";

export { createBotsScreen, parseBotCommands, formatBotCommands } from "./bots_screen.ts";
export type {
  BotsScreenDeps, BotCommand, BotWebhookView, OwnedBotView, BotCommandParseResult,
} from "./bots_screen.ts";
export { createMiniAppsScreen } from "./miniapps_screen.ts";
export type { MiniAppsScreenDeps } from "./miniapps_screen.ts";
export { createMiniAppHost } from "./miniapp_host.ts";
export type { MiniAppHostDeps } from "./miniapp_host.ts";
export {
  parseMiniAppBridgeMessage,
  parseMiniAppAnalytics,
  applyMiniAppControlMessage,
  DEFAULT_MINI_APP_CONTROLS,
  normalizeMiniAppInvoiceCode,
  parseMiniAppInvoiceRequest,
  parseMiniAppInvoiceResult,
  miniAppFramePolicy,
  validateMiniAppOrigin,
  safeMiniAppExternalUrl,
  normalizeMiniAppScopes,
  miniAppNeedsConsentData,
} from "./miniapps_model.ts";
export type {
  MiniAppScope, MiniAppView, MiniAppLaunch, MiniAppBridgeMessage, OwnedBotListItem,
  MiniAppControlsState, MiniAppMainButtonState, MiniAppInvoiceView,
} from "./miniapps_model.ts";
export { miniAppsText, miniAppScopeText } from "./miniapps_strings.ts";
export type { ServerScreenDeps, ServerPort } from "./server_screen.ts";
export { parseServerAddress, sameServer } from "./server_model.ts";
export type { ServerParse } from "./server_model.ts";
export { createImportScreen } from "./import_screen.ts";
export type { ImportScreenDeps } from "./import_screen.ts";
export { createImportModel } from "./import_model.ts";
export type {
  ImportModel, ImportPorts, ImportSource, ImportState, ImportParseResult, ImportDriveProgress, ImportSummary,
} from "./import_model.ts";
export { createFeedScreen } from "./feed_screen.ts";
export type {
  FeedDeps, FeedSelf, OutboxPort, EventFeed, OutboxItemView, OutboxChangeView,
} from "./feed_screen.ts";
export { createComposer } from "./composer.ts";
export type { Composer, ComposerDeps, ComposerSubmit } from "./composer.ts";
export { setPendingShare, hasPendingShare, peekPendingShare, takePendingShare } from "./share.ts";

// T-407 media: the DOM renderers + ports the web shell wires from core (FileUploader + MediaCache).
export { renderAttachment, renderAlbumGroup, cleanupMedia, openViewer, compressImage, networkType, platformDataSaver } from "./media.ts";
export type { MediaPort, MediaEnv, AttachmentDeps, ViewerDeps, UploadedFile, PreparedFile } from "./media.ts";
export { createAttachTray } from "./attach_tray.ts";
export type { AttachTray, AttachTrayDeps } from "./attach_tray.ts";
export {
  sendKindForMime, isImageMime, isVideoMime, isAudioMime, formatBytes, formatDuration,
  autoDownloadDecision, cacheLimitBytes, albumEligible, albumLayout, attachmentView, isBlurred,
  normalizeSpeed, nextSpeed, speedLabel, PLAYBACK_SPEEDS, compressionPlan, waveformBars,
} from "./media_model.ts";
export type {
  SendKind, NetworkType, AutoDownloadPolicy, PlaybackSpeed, CompressionQuality, AttachmentView,
  MediaMeta, ViewerItem, AlbumLayout, AlbumCell,
} from "./media_model.ts";
export { createAccountMediaSettings } from "./media_settings.ts";
export type { AccountMediaSettings, AccountMediaSettingsDeps } from "./media_settings.ts";
export { createBadgeRefreshController } from "./badge_refresh.ts";
export type { BadgeRefreshController, BadgeRefreshDeps } from "./badge_refresh.ts";

export type { ApiLike } from "./api.ts";
export { apiErrorCode, isNetworkError, apiErrorData, describeError } from "./api.ts";
export { validateRegister, validateLogin, PASSWORD_MIN } from "./auth_model.ts";
export type { AuthField, AuthFieldError, AuthValidation, RegisterInput, LoginInput } from "./auth_model.ts";
export {
  filterChats, mutedNow, formatUnread, messagePreview, timeLabel, chatRowView,
} from "./chat_model.ts";
export type { ChatTab, ChatRowView } from "./chat_model.ts";
export {
  mergeMessages, upsertMessage, applyDelete, removeMessage, applyReactionUpdate, toggleReaction,
  sortMessages, historyPath, oldestId, newestId, trimWindow, tickFor, tickGlyph, isMine,
  senderName, messageBody, bubbleView, canEdit, parseMention, filterMembers, applyMention,
  dayKey, dayLabel, needsDaySeparator, presenceLabel,
} from "./feed_model.ts";
export type { HistoryQuery, BubbleView, MentionQuery, Tick, PresenceState } from "./feed_model.ts";
export { PRIVACY_ITEMS, privacyOptions, privacyDefault, normalizePrivacy } from "./privacy_model.ts";
export type { PrivacyItem, PrivacyKind } from "./privacy_model.ts";
export { SETTINGS_ITEMS, settingDefault, settingValue } from "./settings_model.ts";
export type { SettingItem, SettingKind } from "./settings_model.ts";

export {
  CACHE_RETENTION_OPTIONS,
  CHAT_CACHE_OPTIONS,
  normalizeCacheRetention,
  normalizeChatCacheMode,
} from "./cache_policy_model.ts";
export type {
  CacheRetentionMode,
  ChatCacheMode,
  CachePolicyPort,
} from "./cache_policy_model.ts";
// T-503 (BANKING §4) — the display-currency + "≈" surface: pure formatters/models for the future wallet
// screen to connect in one import, plus the first-login suggestion controller the web shell wires.
export { formatApproxFiat, formatCurrencyAmount, APPROX_MARK } from "./approx_fiat_model.ts";
export type { ApproxBadge, ApproxFiatView } from "./approx_fiat_model.ts";
export {
  listSupportedCurrencies, normalizeCurrencyInput, isValidCurrencyCode, currencyLabel,
  currencyLocaleTag, suggestCurrencyFromLocale, planCurrencySuggestion,
} from "./currency_model.ts";
export type { CurrencySuggestPlan } from "./currency_model.ts";
export { maybeSuggestCurrency } from "./currency_suggest.ts";
export type {
  CurrencySuggestFlagPort,
  CurrencySuggestDeps,
} from "./currency_suggest.ts";
export type {
  AuthUser,
  AuthSession,
  Me,
  ChatEntry,
  Badge,
  ChatSettings,
  PrivacyMap,
  SettingsMap,
} from "./types.ts";

// T-512 — MS-2 support/feedback: wire shapes, the form model + overlay, the controller (api + offline
// queue), and the Settings→Help "Мои обращения" view. The web shell wires createSupportController.
export type {
  SupportCategory, SupportDiagnostics, SupportTicketPayload, SupportTicketCreated,
  SupportTicketSummary, SupportTicketList, SupportEvent, SupportTicketDetail,
} from "./api.ts";
export {
  SUPPORT_CATEGORIES, TEXT_MIN as SUPPORT_TEXT_MIN, TEXT_MAX as SUPPORT_TEXT_MAX,
  validateDraft, isSendable, buildPayload, withoutDiagnostics, previewJson,
  categoryLabel, statusLabel, statusLine,
} from "./support_model.ts";
export type { SupportAutoFields, SupportDraft, DraftError, BuildOpts } from "./support_model.ts";
export { createSupportOverlay } from "./support_overlay.ts";
export type { SupportOverlay, SupportOverlayDeps, SupportSubmitResult, SupportPrefill } from "./support_overlay.ts";
export {
  createSupportController, createSupportQueue, classifySupportError, attemptSend,
  SUPPORT_QUEUE_KEY, SUPPORT_QUEUE_MAX,
} from "./support.ts";
export type {
  SupportController, SupportControllerDeps, OpenSupportOptions,
  SupportQueueItem, SupportQueuePort, StorageLike, SupportFailure,
} from "./support.ts";
// The Help implementation is intentionally imported by its two entry points on demand; keeping the
// value in this eager barrel would pull the whole ticket UI into the first chat-list frame.
export type { SupportHelpPort, SupportHelpDeps, SupportHelpView } from "./support_help.ts";
// T-514 — MS-4 §3.1.3 / §14: the static FAQ + the service-status model (client probe of /health + WS
// state, no new server endpoint). The DOM (accordion + card) lives inside the Help view; these are the
// pure, node-tested models + the status probe port the web shell injects.
export { FAQ_IDS, faqEntries } from "./support_faq.ts";
export type { FaqId, FaqEntry } from "./support_faq.ts";
export { serviceLevel, describeStatus, formatUptime, levelLabel, parseHealth } from "./support_status.ts";
export type { HealthInfo, StatusProbe, SupportStatusPort, ServiceLevel, StatusView } from "./support_status.ts";

// T-514 — §4: the client-side service-account (users.is_system) contract — badge + peer-action gating.
// Additive/forward-looking (the server does not emit is_system yet); pure + node-tested on fixtures.
export { isServiceAccount, serviceAccountCaps, serviceAccountLabel } from "./service_account.ts";
export type { ServiceAccountFlags, ServiceAccountCaps } from "./service_account.ts";

// T-514 — MS-4 / T-113: the abuse-report flow the support form's «Пожаловаться…» link opens. A report
// is NOT a ticket (§12): it POSTs /v1/report into the moderation table. The web shell wires onReport.
export type { ReportKind, ReportReason, ReportPayload, ReportResult } from "./api.ts";
export {
  REPORT_REASONS, REPORT_COMMENT_MAX, buildReportPayload, reasonLabel, pickUserByUsername, normalizeUsername,
} from "./report_model.ts";
export type { ReportDraft } from "./report_model.ts";
export { createReportOverlay } from "./report_overlay.ts";
export type { ReportOverlay, ReportOverlayDeps, ReportTarget } from "./report_overlay.ts";

// T-523 (DS-05): generic application-lock screen and settings port.
export { createLockScreen, lockStrengthLabel } from "./lock_screen.ts";
export type {
  AppLockUiPort,
  AppLockUiState,
  AppLockCodeEstimate,
  LockScreenDeps,
} from "./lock_screen.ts";

// Legal re-consent (legal v2): the fail-open gate model + the blocking screen the app shell mounts
// when an account's accepted_version lags the server's current_version (server: modules/legal.ts).
export { createLegalGate } from "./reconsent_model.ts";
export type { LegalGate } from "./reconsent_model.ts";
export { createReconsentScreen } from "./reconsent_screen.ts";
export type { ReconsentScreenDeps } from "./reconsent_screen.ts";
export type { LegalStatus, LegalDoc, LegalAccepted } from "./api.ts";

// V75 — live 1:1 calling. The state machine is pure (no DOM, no WebRTC, no network: media and
// transport are ports), the overlay is its projection, and the shell supplies the browser halves.
export { CallController, IDLE_STATE, callStatusKey, endReasonKey, formatCallTimer } from "./call_model.ts";
export type {
  CallPhase, CallEndReason, CallPeer, CallState, CallControllerDeps,
  CallMediaPort, CallMediaSession, CallSignalPort, IceServer,
} from "./call_model.ts";
export { createCallOverlay } from "./call_overlay.ts";
export type { CallOverlay, CallOverlayDeps } from "./call_overlay.ts";

// V178 — LiveKit-backed group conferences. The state machine remains shell-agnostic; web supplies the
// SFU adapter/overlay while the Calls screen supplies the active-room and start-room entry surface.
export { ConferenceController, IDLE_CONFERENCE_STATE } from "./conference_model.ts";
export type {
  ConferenceApiPort, ConferenceControllerDeps, ConferenceEndReason, ConferenceJoinGrant,
  ConferenceScreenShareGrant, ConferenceMediaOpenOptions, ConferenceMediaPort, ConferenceMediaSession, ConferenceMode,
  ConferenceParticipant, ConferencePhase, ConferenceQualityLevel, ConferenceRole,
  ConferenceState, ScreenShareError,
} from "./conference_model.ts";
export { createConferenceHub, parseConferenceList, canStartConference } from "./conference_hub.ts";
export type { ConferenceHub, ConferenceHubDeps, ConferenceSummary } from "./conference_hub.ts";
export { conferenceText } from "./conference_strings.ts";
export type { ConferenceTextKey } from "./conference_strings.ts";
// V161 — «Контакты»: the shell destination that finally calls the server's contact contour
// (/v1/contacts, shipped since T-113 with no client caller), which the privacy defaults
// birthday/find_by_phone/find_by_email = "contacts" already depend on.
export { createContactsScreen } from "./contacts_screen.ts";
export type { ContactsScreenDeps } from "./contacts_screen.ts";
export {
  ContactsError, addContact, addableUsers, contactSubtitle, contactTitle,
  filterContacts, isContactsLimit, loadContacts, matchesQuery, parseContacts, removeContact,
} from "./contacts_model.ts";
export type { ContactRow, ContactsErrorCode } from "./contacts_model.ts";
export { describeCall, groupCallsByDay, missedCount, parseCallHistory } from "./calls_model.ts";
export type { CallHistoryItem, CallHistoryPage, CallLogLine, CallLogPeer, CallDirection, CallStatus } from "./calls_model.ts";
