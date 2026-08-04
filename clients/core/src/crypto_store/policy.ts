// crypto_store/policy.ts — неизменяемая политика формата v1 (T-519, DS-01).

import {
  ARGON2_DEFAULT,
  ARGON2_WEAK,
  type Argon2idParams,
  type PlatformClass,
} from "./types.ts";

const ARGON2_ALLOWED_MEMORY_KIB = new Set([
  ARGON2_WEAK.memLimitKib,
  ARGON2_DEFAULT.memLimitKib,
]);

/** Формат v1 допускает только параметры из DEVICE_SECURITY.md §3.1. */
export function assertArgon2idParams(value: unknown): asserts value is Argon2idParams {
  if (!value || typeof value !== "object") {
    throw new Error("crypto_store: параметры Argon2id должны быть объектом");
  }
  const params = value as Partial<Argon2idParams>;
  if (
    params.opsLimit !== 3 ||
    params.parallelism !== 1 ||
    typeof params.memLimitKib !== "number" ||
    !ARGON2_ALLOWED_MEMORY_KIB.has(params.memLimitKib)
  ) {
    throw new Error(
      "crypto_store: параметры Argon2id v1 должны быть m=64/32 МиБ, t=3, p=1",
    );
  }
}

/** Матрица §3.2: все классы, кроме честного web-user-only, требуют S_hw. */
export function platformClassUsesHardwareSecret(platformClass: PlatformClass): boolean {
  return platformClass !== "web-user-only";
}
