import {
  apiErrorCode,
  type ApiLike,
  type ResolvedUser,
  type SearchUser,
} from "./api.ts";
import { normalizeUsername } from "./report_model.ts";
import { isServiceAccount } from "./service_account.ts";

export type SafetyErrorCode =
  | "username_required"
  | "search_unavailable"
  | "user_not_found"
  | "self"
  | "service_account"
  | "invalid_response";

export class SafetyControlError extends Error {
  readonly code: SafetyErrorCode;

  constructor(code: SafetyErrorCode, message: string) {
    super(message);
    this.name = "SafetyControlError";
    this.code = code;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Safety view is no longer active");
  error.name = "AbortError";
  throw error;
}

export async function loadBlockedUsers(api: ApiLike): Promise<SearchUser[]> {
  const rows = await api.get<unknown>("/v1/blocks");
  if (!Array.isArray(rows) || !rows.every(isSearchUser)) {
    throw new SafetyControlError(
      "invalid_response",
      "Invalid blocked-user list response",
    );
  }
  return rows;
}

function isSearchUser(value: unknown): value is SearchUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<ResolvedUser> & Record<string, unknown>;
  return (
    user.deleted !== true &&
    Number.isSafeInteger(user.id) &&
    Number(user.id) > 0 &&
    typeof user.username === "string" &&
    typeof user.name === "string" &&
    typeof user.is_bot === "boolean" &&
    (user.avatar_file_id === null || Number.isSafeInteger(user.avatar_file_id))
  );
}

export async function blockUserByUsername(
  api: ApiLike,
  raw: string,
  selfId: number,
  signal?: AbortSignal,
): Promise<SearchUser> {
  throwIfAborted(signal);
  const username = normalizeUsername(raw);
  if (!username)
    throw new SafetyControlError("username_required", "Username is required");
  if (!api.resolveUser)
    throw new SafetyControlError(
      "search_unavailable",
      "User search is unavailable",
    );
  let resolved: ResolvedUser;
  try {
    resolved = await api.resolveUser(username);
  } catch (error) {
    if (apiErrorCode(error) === "NOT_FOUND")
      throw new SafetyControlError("user_not_found", "User was not found");
    throw error;
  }
  throwIfAborted(signal);
  if (!isSearchUser(resolved))
    throw new SafetyControlError("user_not_found", "User was not found");
  const target = resolved;
  if (target.id === selfId)
    throw new SafetyControlError("self", "You cannot block yourself");
  if (isServiceAccount(target)) {
    throw new SafetyControlError(
      "service_account",
      "You cannot block a service account",
    );
  }
  throwIfAborted(signal);
  const blocked = await api.post<unknown>(`/v1/blocks/${target.id}`, {});
  throwIfAborted(signal);
  if (!isSearchUser(blocked) || blocked.id !== target.id) {
    throw new SafetyControlError(
      "invalid_response",
      "Invalid block response",
    );
  }
  return blocked;
}

export async function unblockUser(
  api: ApiLike,
  userId: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("Invalid blocked user id");
  throwIfAborted(signal);
  await api.delete(`/v1/blocks/${userId}`);
}
