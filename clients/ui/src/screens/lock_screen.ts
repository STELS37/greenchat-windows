// clients/ui/src/screens/lock_screen.ts — generic application lock UI (T-523, DS-05).
//
// Privacy invariant: this screen never receives or renders a user name, chat title, avatar,
// unread count, message preview or any other account-derived value.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";

export type AppLockUiState = "DISABLED" | "COLD" | "UNLOCKED" | "LOCKED" | "WIPED";

export interface AppLockCodeEstimate {
  valid: boolean;
  problem: "empty" | "pin_too_short" | "passphrase_too_short" | "passphrase_required" | null;
  score: 0 | 1 | 2 | 3 | 4;
  kind: "pin" | "passphrase";
}

export interface AppLockBiometricStatus {
  available: boolean;
  enabled: boolean;
  ready: boolean;
  codeRequired: boolean;
  failures: number;
}

export interface AppLockColdStatus {
  profile: "default" | "paranoid";
  codeRequired: boolean;
  reason: "reboot" | "inactivity" | "biometric_failures" | "periodic_reauth" | null;
}

export interface AppLockDuressStatus {
  enabled: boolean;
  signal: boolean;
}

export interface AppLockUiPort {
  readonly state: AppLockUiState;
  readonly enabled: boolean;
  readonly policy: {
    wipeAfter: number | null;
    requirePassphrase: boolean;
    profile?: "default" | "paranoid";
  };
  readonly attempts: { failures: number; blockedUntil: number };

  readonly biometric: AppLockBiometricStatus;

  readonly cold: AppLockColdStatus;

  readonly duress: AppLockDuressStatus;
  retryAfterSeconds(): number;
  estimate(code: string): AppLockCodeEstimate;
  subscribe(listener: (state: AppLockUiState) => void): () => void;
  unlock(code: string): Promise<void>;

  unlockBiometric(): Promise<void>;
  enable(code: string, policy: {
    wipeAfter: number | null;
    requirePassphrase?: boolean;
    profile?: "default" | "paranoid";
  }): Promise<void>;
  changeCode(currentCode: string, newCode: string): Promise<void>;
  setWipeAfter(value: number | null): Promise<void>;

  setProfile(profile: "default" | "paranoid"): Promise<void>;

  configureDuress(currentCode: string, duressCode: string, trustedUsername?: string | null): Promise<void>;
  disableDuress(currentCode: string): Promise<void>;

  setBiometricEnabled(enabled: boolean): Promise<void>;
  disableAndWipe(code: string): Promise<void>;
  resetAfterWipe(): Promise<void>;
  lock(): void;
}

export interface LockScreenDeps {
  i18n: I18n;
  lock: AppLockUiPort;
}

function problemText(i18n: I18n, problem: AppLockCodeEstimate["problem"]): string {
  if (!problem) return "";
  return i18n.t(`lock.problem.${problem}`);
}

function codeRequiredText(i18n: I18n, lock: AppLockUiPort): string {
  return lock.cold.reason ? i18n.t(`lock.cold.${lock.cold.reason}`) : i18n.t("lock.codeRequired");
}

// The routed shell may fully remount this screen after any AppLock snapshot update. Keep the automatic
// prompt guard on the stable port object, not on a DOM instance, so one failed prompt cannot recursively
// create five fresh screens/prompts. A successful code/biometric unlock clears it for the next lock cycle.
const autoPromptedLocks = new WeakSet<AppLockUiPort>();

export function createLockScreen(deps: LockScreenDeps): { root: HTMLElement; destroy(): void } {
  const { i18n, lock } = deps;
  const root = el("main", {
    class: "gc-lock",
    "aria-label": i18n.t("lock.title"),
  });
  let disposed = false;
  let tick: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;


  const stopTick = (): void => {
    if (tick) clearInterval(tick);
    tick = null;
  };

  const renderWiped = (): void => {
    stopTick();
    clear(root);
    const status = el("p", { class: "gc-lock-status", role: "status" }, [i18n.t("lock.wiped")]);
    const reset = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [
      i18n.t("lock.resetAfterWipe"),
    ]);
    reset.addEventListener("click", async () => {
      reset.setAttribute("disabled", "");
      status.textContent = i18n.t("common.loading");
      try {
        await lock.resetAfterWipe();
      } catch {
        status.textContent = i18n.t("lock.error");
        reset.removeAttribute("disabled");
      }
    });
    root.append(
      el("section", { class: "gc-lock-card" }, [
        el("div", { class: "gc-lock-mark", "aria-hidden": true }, [icon("shield")]),
        el("h1", { class: "gc-lock-title" }, [i18n.t("common.appName")]),
        el("p", { class: "gc-lock-subtitle" }, [i18n.t("lock.wipedTitle")]),
        status,
        reset,
      ]),
    );
  };
  const renderLocked = (): void => {
    stopTick();
    clear(root);
    const input = el("input", {
      type: "password",
      class: "gc-input gc-lock-input",
      autocomplete: "current-password",
      autocapitalize: "none",
      spellcheck: false,
      inputmode: "text",
      // V115: a screen reader announces the accessible name and never the placeholder, so both have to
      // name the SAME secret. Where the device has no hardware-backed key the lock accepts a passphrase
      // only (see web/src/native_shell.ts), and an "app code" prompt would send a blind user straight
      // into the refusal a sighted user is spared.
      "aria-label": i18n.t(lock.policy.requirePassphrase ? "lock.passphrase" : "lock.code"),
      placeholder: i18n.t(lock.policy.requirePassphrase ? "lock.passphrase" : "lock.code"),
    }) as HTMLInputElement;
    const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent" }, [
      i18n.t("lock.unlock"),
    ]) as HTMLButtonElement;
    const status = el("p", {
      class: "gc-lock-status",
      role: "status",
      "aria-live": "polite",
    });
    const attempts = el("p", { class: "gc-lock-attempts" });
    let biometricBusy = false;

    const biometricButton = lock.biometric.ready
      ? el("button", { type: "button", class: "gc-btn gc-lock-biometric" }, [
          i18n.t("lock.biometricUnlock"),
        ]) as HTMLButtonElement
      : null;

    const updateThrottle = (): void => {
      if (disposed) return;
      const seconds = lock.retryAfterSeconds();
      submit.disabled = seconds > 0;
      input.disabled = seconds > 0;
      if (seconds > 0) {
        status.textContent = i18n.t("lock.retryIn", { seconds: String(seconds) });
      } else if (status.dataset.throttle === "1") {
        status.textContent = "";
        delete status.dataset.throttle;
        input.disabled = false;
        input.focus();
      }
      if (seconds > 0) status.dataset.throttle = "1";
      const failures = lock.attempts.failures;
      const wipeAfter = lock.policy.wipeAfter;
      attempts.textContent = failures > 0 && wipeAfter !== null
        ? i18n.t("lock.attempts", {
            failures: String(failures),
            remaining: String(Math.max(0, wipeAfter - failures)),
          })
        : "";
    };

    const attemptBiometric = async (): Promise<void> => {
      if (!lock.biometric.ready || biometricBusy || disposed) return;
      biometricBusy = true;
      if (biometricButton) biometricButton.disabled = true;
      status.textContent = i18n.t("lock.biometricUnlocking");
      try {
        await lock.unlockBiometric();

        autoPromptedLocks.delete(lock);
      } catch (error) {
        if (lock.state === "UNLOCKED") return;
        const problem = typeof error === "object" && error !== null && "problem" in error
          ? String((error as { problem?: unknown }).problem)
          : "unavailable";
        status.textContent = problem === "cancelled"
          ? i18n.t("lock.biometricCancelled")
          : problem === "code_required"
            ? codeRequiredText(i18n, lock)
            : problem === "busy"
              ? i18n.t("lock.biometricUnlocking")
              : i18n.t("lock.biometricUnavailable");
        updateThrottle();
        if (!input.disabled) queueMicrotask(() => input.focus());
      } finally {
        biometricBusy = false;
        if (biometricButton && root.contains(biometricButton)) {
          biometricButton.disabled = !lock.biometric.ready;
        }
      }
    };
    biometricButton?.addEventListener("click", () => void attemptBiometric());

    const form = el("form", { class: "gc-lock-form" }, [input, submit]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = input.value;
      if (!code) {
        status.textContent = i18n.t("lock.problem.empty");
        return;
      }
      submit.disabled = true;
      input.disabled = true;
      status.textContent = i18n.t("lock.unlocking");
      try {
        await lock.unlock(code);

        autoPromptedLocks.delete(lock);
        input.value = "";
      } catch (error) {
        const retry = typeof error === "object" && error !== null && "retryAfterSeconds" in error
          ? Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds)
          : lock.retryAfterSeconds();
        if (lock.state === "WIPED") {
          renderWiped();
          return;
        }
        status.textContent = retry > 0
          ? i18n.t("lock.retryIn", { seconds: String(retry) })
          : i18n.t("lock.wrongCode");
        input.value = "";
        input.disabled = false;
        submit.disabled = false;
        updateThrottle();
      }
    });

    const controls: HTMLElement[] = [];
    if (biometricButton) controls.push(biometricButton);
    controls.push(form, status, attempts);
    root.append(
      el("section", { class: "gc-lock-card" }, [
        el("div", { class: "gc-lock-mark", "aria-hidden": true }, [icon("lock")]),
        el("h1", { class: "gc-lock-title" }, [i18n.t("common.appName")]),
        // V114: the field below is labelled «Парольная фраза» whenever the policy demands one, so the
        // subtitle must name the same secret instead of asking for an app code the lock will reject.
        el("p", { class: "gc-lock-subtitle" }, [
          i18n.t(lock.policy.requirePassphrase ? "lock.subtitlePassphrase" : "lock.subtitle"),
        ]),
        ...controls,
      ]),
    );

    updateThrottle();
    if (lock.biometric.codeRequired) status.textContent = codeRequiredText(i18n, lock);
    tick = setInterval(updateThrottle, 250);
    if (lock.biometric.ready && !autoPromptedLocks.has(lock)) {
      autoPromptedLocks.add(lock);
      queueMicrotask(() => void attemptBiometric());
    } else if (!input.disabled) {
      queueMicrotask(() => input.focus());
    }
  };

  const render = (): void => {
    if (disposed) return;
    if (lock.state === "WIPED") renderWiped();
    else renderLocked();
  };


  unsubscribe = lock.subscribe((state) => {
    if (state === "UNLOCKED" || state === "DISABLED") {
      autoPromptedLocks.delete(lock);
      stopTick();
      clear(root);
      return;
    }
    if (state === "WIPED") autoPromptedLocks.delete(lock);
    render();
  });
  render();

  return {
    root,
    destroy() {
      disposed = true;
      stopTick();
      unsubscribe?.();
      unsubscribe = null;
      clear(root);
    },
  };
}

export function lockStrengthLabel(i18n: I18n, estimate: AppLockCodeEstimate): string {
  if (!estimate.valid) return problemText(i18n, estimate.problem);
  return i18n.t(`lock.strength.${estimate.score}`);
}
