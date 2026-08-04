// clients/core — Green Chat client SDK (0 runtime dependencies).
//
// Public surface. T-402 landed the transport layer (ApiClient/WsClient/SyncEngine); T-403 adds the
// cache/offline substrate (ClientStore + IndexedDB, Outbox, file uploader + LRU media cache, and the
// CacheSync glue for instant-render cold start). The push bridge (§5.4) landed in T-414.
// Node 22's native fetch/WebSocket back the tests (`node --test` against a live local server) —
// no polyfills, no deps.
export const CLIENT_CORE_VERSION = "0.1.0" as const;

export { ApiError, NetworkError, type WireError } from "./errors.ts";
export {
  ApiClient,
  createRefreshSuccessor,
  type ApiClientOptions,
  type RequestOptions,
  type RequestObservation,
  type AccountDeletionResult,
  type ResolvedUser,
  type TokenStore,
  type RefreshCoordinator,
  type HttpMethod,
} from "./api.ts";
export {
  WsClient,
  toWsUrl,
  CLOSE_AUTH,
  type WsClientOptions,
  type WsState,
  type CallSignalFrame,
} from "./ws.ts";
export { SyncEngine, type SyncEngineOptions } from "./sync.ts";
export type {
  SyncEvent,
  HelloFrame,
  WsEventFrame,
  PongFrame,
  LongPollEvent,
  UpdatesResponse,
  SessionResult,
} from "./types.ts";

// T-403 — cache / offline substrate.
export {
  MemoryStore,
  COLLECTIONS,
  type ClientStore,
  type Collection,
  type StoreKey,
  type StoreEntry,
  type ScanQuery,
  type WriteOp,
} from "./store.ts";
export { IndexedDbStore, type IndexedDbStoreOptions } from "./indexeddb_store.ts";

export {
  LocalCachePolicy,
  isCacheRetentionMode,
  isChatCacheMode,
  normalizePolicySnapshot,
  type LocalCachePolicyOptions,
  type CachePolicyReader,
  type CacheRetentionMode,
  type ChatCacheMode,
  type EffectiveCacheMode,
} from "./retention.ts";
export {
  Outbox,
  type OutboxOptions,
  type OutboxExclusive,
  type OutboxItem,
  type OutboxChange,
  type OutboxKind,
  type OutboxStatus,
} from "./outbox.ts";
export {
  FileUploader,
  type FileUploaderOptions,
  type UploadOptions,
  type UploadResult,
} from "./upload.ts";
export {
  MediaCache,
  type MediaCacheOptions,
  type MediaBlob,
  type MediaCacheAccessOptions,
} from "./media_cache.ts";
export { CacheSync, type CacheSyncOptions } from "./cache.ts";

// §5.4 — push subscription seam + core-side registrar (Android T-414 / iOS T-415 install the bridge).
export {
  registerPush,
  type PushBridge,
  type PushToken,
  type PushData,
  type PushApi,
  type PushPlatform,
  type PushRegistration,
} from "./push.ts";

// T-451 — provider-neutral external messenger connector contract and capability negotiation.
export {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_OPERATION_CAPABILITY,
  ConnectorCapabilityError,
  ConnectorEventGate,
  ConnectorRegistry,
  assertConnectorProviderId,
  assertConnectorAccountRef,
  assertConnectorChatRef,
  assertConnectorMessageRef,
  compareConnectorSequence,
  connectorAccountKey,
  connectorChatKey,
  connectorMessageKey,
  normalizeConnectorSequence,
  requireConnectorCapability,
  resolveConnectorCapabilities,
  validateConnectorCommand,
  type ConnectorAccountRef,
  type ConnectorAdapter,
  type ConnectorAuthInput,
  type ConnectorCapability,
  type ConnectorCapabilityDecision,
  type ConnectorCapabilityLayers,
  type ConnectorCapabilityMatrix,
  type ConnectorCapabilityOverrides,
  type ConnectorCapabilitySource,
  type ConnectorCapabilityState,
  type ConnectorChat,
  type ConnectorChatRef,
  type ConnectorCommand,
  type ConnectorCommandResult,
  type ConnectorCompliance,
  type ConnectorDiagnostic,
  type ConnectorEvent,
  type ConnectorEventKind,
  type ConnectorEventVerdict,
  type ConnectorLoginState,
  type ConnectorManifest,
  type ConnectorMessage,
  type ConnectorMessageRef,
  type ConnectorOpenContext,
  type ConnectorOperation,
  type ConnectorPlatform,
  type ConnectorSession,
  type ConnectorSyncPage,
  type ConnectorSyncRequest,
  type ScopedConnectorVault,
} from "./connectors.ts";

// T-451/T-452 — connector-only native OS secret vault (separate from GreenChat auth/wallet keys).
export {
  createNativeScopedConnectorVault,
  deriveConnectorVaultScope,
  nativeConnectorVaultCapability,
  type ConnectorVaultDigest,
  type ConnectorVaultScopeIdentity,
  type NativeConnectorSecretVault,
} from "./connector_vault.ts";

// T-452 — local Telegram connection lifecycle for settings/auth UI and account-boundary cleanup.
export {
  createTelegramConnectionController,
  type TelegramConnectionController,
  type TelegramConnectionControllerOptions,
  type TelegramConnectionReason,
  type TelegramConnectionSnapshot,
} from "./telegram_connection.ts";

// T-453A/T-453B — protected Telegram catalogue, bounded all-slot runtime and background metadata events.
export {
  TELEGRAM_ACCOUNT_CATALOG_SLOT,
  TELEGRAM_LEGACY_ACCOUNT_SLOT,
  TELEGRAM_MAX_LOCAL_ACCOUNTS,
  createTelegramAccountsController,
  type TelegramAccountEvent,
  type TelegramAccountSummary,
  type TelegramAccountSyncState,
  type TelegramAccountsController,
  type TelegramAccountsControllerOptions,
  type TelegramAccountsSnapshot,
} from "./telegram_accounts.ts";

// T-452 — official Telegram TDLib JSON connector. Native shells supply the tdjson receive loop;
// the shared core owns auth, lossless int53 IDs, @extra correlation and Connector SDK normalization.
export {
  TELEGRAM_PROVIDER_ID,
  TELEGRAM_TDLIB_MANIFEST,

  TelegramTdlibError,
  createTelegramTdlibAdapter,
  parseTdJsonLossless,
  stringifyTdJson,
  tdInt64,

  wipeTelegramTdlibLocal,
  type TdInt64,
  type TdJsonValue,
  type TelegramConnectorOptions,
  type TelegramTdlibAdapterPort,
  type TelegramTdlibBridge,
  type TelegramTdlibBridgeClient,
  type TelegramTdlibBridgeInfo,
  type TelegramTdlibBridgeOpenOptions,
  type TelegramTdlibSessionPort,
} from "./telegram_tdlib.ts";

// T-417 — Telegram export parser + import driver («переезд»), and the zero-dep ZIP reader it uses.
export {
  parseTelegramExport,
  flattenTgText,
  guessMimeFromName,
  batchMessages,
  runTelegramImport,
  TG_IMPORT_BATCH_SIZE,
  type TgMessage,
  type TgParsed,
  type TgImportBatchMessage,
  type TgImportBatch,
  type TgImportResult,
  type TgImportProgress,
  type TgImportPorts,
} from "./tg_import.ts";
export { ZipArchive } from "./zip.ts";

// T-419 — network resilience + «свой сервер»: runtime-switchable endpoint with sticky auto-failover and
// the anti-exfiltration fetch/WebSocket wrappers the transports inject as fetchImpl/wsImpl.
export {
  createEndpointManager,
  createEndpointFetch,
  createEndpointWebSocket,
  normalizeBase,
  type EndpointManager,
  type EndpointManagerOptions,
  type EndpointSwitchReason,
} from "./endpoints.ts";

// T-604 — server-driven L0/L1 selection, health probes and encrypted per-network sticky memory.
export {
  createConnectionManager,
  memoryConnKv,
  DEFAULT_POLICY,
  type ConnectionManager,
  type ConnectionManagerOptions,
  type ConnConfig,
  type ConnKv,
  type ConnStatus,
  type ConnSwitchReason,
  type EndpointHealth,
  type ProbeResult,
} from "./conn_manager.ts";

// T-125 — clock correction from public /v1/config.
export { ServerClock } from "./server_clock.ts";

// GC_MESSENGER_DIRECT_APK_ONLY_START
// T-413 — native update verdict from the self-hosted manifest (Android APK channel; web/PWA never
// calls this — its update path is the service worker).
export { fetchUpdateStatus, compareUpdateVersions } from "./update_checker.ts";
export type {
  UpdateStatus,
  UpdateState,
  FetchUpdateStatusOptions,
} from "./update_checker.ts";
// GC_MESSENGER_DIRECT_APK_ONLY_END

// T-418 — client-quality telemetry controller (crash-free + push-latency KPIs, strictly opt-in).
export {
  createDiagnostics,
  quantile,
  computeAggregate,
  type Diagnostics,
  type DiagnosticsOptions,
  type DiagStore,
  type DiagApi,
  type DiagMeta,
  type DiagPlatform,
  type CrashCapture,
  type QueuedCrash,
  type LatencySample,
} from "./diagnostics.ts";


// Open Beta crash-free denominator: privacy-safe, opt-in cumulative app-session aggregates.
export {
  createSessionQuality,
  type SessionQuality,
  type SessionQualityApi,
  type SessionQualityMeta,
  type SessionQualityOptions,
  type SessionQualityPlatform,
  type SessionQualityScheduler,
  type SessionQualityStorage,
} from "./session_quality.ts";

// T-512 — MS-2 support/feedback: the in-RAM diagnostics ring buffer a user may attach to a ticket. All
// R1–R7 redaction happens at write time (reuses diag_redact.ts); nothing here persists to disk.
export {
  createDiagBuffer,
  MAX_ENTRIES as DIAG_MAX_ENTRIES,
  MAX_BYTES as DIAG_MAX_BYTES,
  type DiagBuffer,
  type DiagBufferOptions,
  type DiagEntry,
  type DiagEnv,
  type DiagKind,
  type DiagSnapshot,
} from "./diag_buffer.ts";

// T-514 — MS-4: the crash snapshot the ring is allowed to persist (SUPPORT.md §2.3 R7). Saved on an
// uncaught crash, offered for sending on the next launch; already-redacted, one snapshot, capped, and
// under a localStorage key distinct from the offline ticket queue and every T-418 diagnostics key.
export {
  saveCrashSnapshot,
  readCrashSnapshot,
  clearCrashSnapshot,
  isBrowserLayoutNotice,
  CRASH_SNAPSHOT_KEY,
  CRASH_SNAPSHOT_MAX_BYTES,
  type CrashSnapshot,
  type CrashStorageLike,
  type SaveCrashOptions,
} from "./crash_snapshot.ts";
export {
  EncryptedStore,
  EncryptedStoreIntegrityError,
  type EncryptedStoreOptions,
  type DbKeyProvider,
} from "./encrypted_store.ts"; // T-520 (DS-02) — AES-256-GCM(K_db) поверх ClientStore

// T-523 (DS-05): local application lock and platform crypto factors.
export {
  AppLockController,
  InvalidAppCodeError,
  AppLockThrottledError,
  AppLockFailedError,
  AppLockWipedError,
  AppLockMigrationError,
  AppBiometricError,

  DuressCodeConflictError,
  createBiometricWrap,
  unlockBiometricWrap,
  parseBiometricWrap,
  InvalidBiometricWrapError,
  BiometricWrapInvalidatedError,
  estimateAppCode,
  assertValidAppCode,
  appLockDelaySeconds,
  normalizeWipeAfter,
  normalizeAppLockSnapshot,
  APP_LOCK_WIPE_DEFAULT,
  APP_LOCK_WIPE_MIN,
  APP_LOCK_WIPE_MAX,
  APP_LOCK_DELAY_CAP_SECONDS,

  APP_LOCK_BIOMETRIC_FAILURE_LIMIT,
  APP_LOCK_PARANOID_INACTIVITY_SECONDS,
  APP_LOCK_PARANOID_REAUTH_SECONDS,
  argon2idUserSecret,
  secureKeyHardwareSecret,

  secureKeyBiometricSecret,
  // The shells need the canonical list to recognise the class an existing container was written with.
  PLATFORM_CLASSES,
  type SecureKey,
  type AppLockState,

  type AppLockProfile,
  type AppColdReason,
  type AppCodeKind,
  type AppCodeProblem,
  type AppCodeStrength,
  type AppCodeEstimate,
  type AppLockPolicy,
  type AppLockAttempts,
  type AppLockMigrationState,
  type AppLockMigrationKeys,
  type AppBiometricProblem,
  type AppBiometricSnapshot,
  type AppBiometricStatus,

  type AppColdSnapshot,
  type AppColdStatus,

  type AppDuressStatus,
  type BiometricWrap,
  type AppLockSnapshot,
  type AppLockPersistence,
  type AppLockControllerOptions,
  type PlatformClass,
  type KekFactors,

  type DuressAction,
  type DuressEnvelope,
  type WrappedContainer,
  type WipedContainerTombstone,
  type PlatformSignals,
  type LockClock,
} from "./crypto_store/index.ts";

// T-121 — client PoW for the anti-bot registration gate (GC_POW): the bounded solver and the
// POW_REQUIRED retry gate the auth flows call through (web runs the solver in a Web Worker).
export {
  solvePowChallenge,
  leadingZeroBits,
  PowChallengeError,
  PowExpiredError,
  PowAbortedError,
  PowExhaustedError,
  type PowChallenge,
  type PowSolution,
  type SolvePowOptions,
  type PowHash,
} from "./pow_solver.ts";
export {
  executeWithPow,
  type PowWire,
  type PowRunner,
  type PowRunnerOptions,
  type PowGateOptions,
} from "./pow_gate.ts";
