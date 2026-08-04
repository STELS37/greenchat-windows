// clients/ui/src/screens/reconsent_model.ts — the legal re-consent gate (legal v2, client half).
//
// A known consent debt blocks every authenticated screen until the exact displayed edition is
// accepted or the person signs out. A status probe is fail-open ONLY when the endpoint is genuinely
// unavailable (network/timeout/5xx): the server still enforces LEGAL_RECONSENT on writes. Contract
// errors, non-transient 4xx and malformed successful payloads are not equivalent to "offline" and
// therefore produce a blocking retry/logout verdict instead of silently opening the application.
import type { ApiLike, LegalStatus } from "./api.ts";
import { isNetworkError } from "./api.ts";

export interface LegalGate {
  blocking(): LegalStatus | null;
  failure(): unknown | null;
  // Single-flight within one account epoch. reset() invalidates every older in-flight response.
  check(): Promise<void>;
  markAccepted(): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

function httpStatusOf(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return typeof status === "number" && Number.isFinite(status) ? status : 0;
}

function transientProbeFailure(error: unknown): boolean {
  return isNetworkError(error) || httpStatusOf(error) >= 500;
}

export function parseLegalStatus(value: unknown): LegalStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid legal status payload");
  }
  const row = value as Record<string, unknown>;
  const accepted = row["accepted_version"];
  const current = row["current_version"];
  const required = row["reconsent_required"];
  const acceptedValid = accepted === null ||
    (typeof accepted === "number" && Number.isSafeInteger(accepted) && accepted >= 0);
  if (
    !acceptedValid ||
    typeof current !== "number" || !Number.isSafeInteger(current) || current < 1 ||
    typeof required !== "boolean"
  ) {
    throw new Error("invalid legal status payload");
  }
  const expectedRequired = accepted === null || accepted < current;
  if (accepted !== null && accepted > current) throw new Error("invalid legal status payload");
  if (required !== expectedRequired) throw new Error("inconsistent legal status payload");
  return { accepted_version: accepted as number | null, current_version: current, reconsent_required: required };
}

export function createLegalGate(deps: { api: ApiLike }): LegalGate {
  const { api } = deps;
  let status: LegalStatus | null = null;
  let fatalFailure: unknown | null = null;
  let inflight: Promise<void> | null = null;
  let epoch = 0;
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const listener of [...listeners]) listener(); };
  const blocking = (): LegalStatus | null => status?.reconsent_required ? status : null;

  const verdictKey = (): string => {
    const owed = blocking();
    if (fatalFailure !== null) return "failure";
    return owed ? `owed:${owed.current_version}` : "open";
  };

  return {
    blocking,
    failure: () => fatalFailure,
    check(): Promise<void> {
      if (inflight) return inflight;
      const checkEpoch = epoch;
      let operation: Promise<void>;
      operation = (async () => {
        const before = verdictKey();
        let raw: unknown;
        try {
          raw = await (api.getLegalStatus
            ? api.getLegalStatus()
            : api.get<unknown>("/v1/legal/status"));
        } catch (error) {
          if (checkEpoch !== epoch) return;
          if (transientProbeFailure(error)) return; // unknown/unavailable => fail-open; known fatal stays blocked
          status = null;
          fatalFailure = error;
          if (before !== verdictKey()) emit();
          return;
        }
        if (checkEpoch !== epoch) return;
        try {
          status = parseLegalStatus(raw);
          fatalFailure = null;
        } catch (error) {
          status = null;
          fatalFailure = error;
        }
        if (before !== verdictKey()) emit();
      })().finally(() => {
        if (checkEpoch === epoch && inflight === operation) inflight = null;
      });
      inflight = operation;
      return operation;
    },
    markAccepted(): void {
      if (!blocking()) return;
      if (status) status = { ...status, accepted_version: status.current_version, reconsent_required: false };
      fatalFailure = null;
      emit();
    },
    reset(): void {
      epoch++;
      status = null;
      fatalFailure = null;
      inflight = null;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
