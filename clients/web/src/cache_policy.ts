// clients/web — T-529 transactional glue between encrypted policy and the Outbox persistence plane.
import type { CacheRetentionMode, ChatCacheMode } from "../../core/src/retention.ts";
import type { CachePolicyPort } from "../../ui/src/screens/cache_policy_model.ts";

export interface WebCachePolicyBackend {
  globalMode(): CacheRetentionMode;
  setGlobal(mode: CacheRetentionMode): Promise<void>;
  chatMode(chatId: number): ChatCacheMode;
  setChat(chatId: number, mode: ChatCacheMode): Promise<void>;
  shouldPersistChat(chatId: number): boolean;
  recordMedia(chatId: number, fileId: number): Promise<void>;
  subscribe(handler: () => void): () => void;
}

export interface OutboxPersistencePlane {
  applyPersistencePolicy(chatId?: number, persistOverride?: boolean): Promise<void>;
}

async function restoreOutbox(
  outbox: OutboxPersistencePlane,
  chatId: number,
  persist: boolean,
): Promise<void> {
  try {
    await outbox.applyPersistencePolicy(chatId, persist);
  } catch {
    // Preserve the original transition error. A later startSync/list reconciliation retries the same move.
  }
}

export function createWebCachePolicyPort(
  policy: WebCachePolicyBackend,
  outbox: OutboxPersistencePlane,
): CachePolicyPort {
  const chatTransitions = new Map<number, Promise<void>>();

  const transitionChat = async (chatId: number, mode: ChatCacheMode): Promise<void> => {
    const previousMode = policy.chatMode(chatId);
    const previousPersist = policy.shouldPersistChat(chatId);
    const nextPersist = mode !== "cloud_only";

    if (previousPersist !== nextPersist) {
      // Entering cloud-only: remove durable outbox first. Leaving it: the user's explicit opt-out starts
      // by encrypting pending rows durably. In either direction a policy failure restores the old plane.
      try {
        await outbox.applyPersistencePolicy(chatId, nextPersist);
      } catch (error) {
        await restoreOutbox(outbox, chatId, previousPersist);
        throw error;
      }
    }

    try {
      await policy.setChat(chatId, mode);
    } catch (error) {
      if (previousPersist !== nextPersist) await restoreOutbox(outbox, chatId, previousPersist);
      // The backend rolls its in-memory snapshot back. Keep the selector on the true previous mode.
      if (policy.chatMode(chatId) !== previousMode) {
        try { await policy.setChat(chatId, previousMode); } catch { /* best-effort durable rollback */ }
      }
      throw error;
    }
  };

  const enqueueChatTransition = (chatId: number, mode: ChatCacheMode): Promise<void> => {
    const previous = chatTransitions.get(chatId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => transitionChat(chatId, mode));
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (chatTransitions.get(chatId) === tracked) chatTransitions.delete(chatId);
    });
    chatTransitions.set(chatId, tracked);
    return tracked;
  };

  return {
    getGlobal: () => policy.globalMode(),
    setGlobal: (mode) => policy.setGlobal(mode),
    getChat: (chatId) => policy.chatMode(chatId),
    setChat: (chatId, mode) => enqueueChatTransition(chatId, mode),
    shouldPersist: (chatId) => policy.shouldPersistChat(chatId),
    recordMedia: (chatId, fileId) => policy.recordMedia(chatId, fileId),
    subscribe: (handler) => policy.subscribe(handler),
  };
}
