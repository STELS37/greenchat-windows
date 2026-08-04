// clients/ui/src/screens/lock_settings.ts — application-lock/security settings (T-523..T-526).
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import { lockStrengthLabel, type AppLockUiPort } from "./lock_screen.ts";

export interface LockSettingsDeps {
  i18n: I18n;
  lock: AppLockUiPort;
  status: HTMLElement;
  rerender(): void;
}

function wipeSelect(i18n: I18n, current: number | null): HTMLSelectElement {
  const select = el("select", { class: "gc-select", "aria-label": i18n.t("lock.wipeAfter") }) as HTMLSelectElement;
  const values: Array<number | null> = [null, 5, 10, 15, 20];
  for (const value of values) {
    const option = el("option", { value: value === null ? "off" : String(value) }, [
      value === null ? i18n.t("lock.wipeOff") : i18n.t("lock.wipeCount", { count: String(value) }),
    ]) as HTMLOptionElement;
    option.selected = value === current;
    select.append(option);
  }
  return select;
}

function passwordInput(i18n: I18n, placeholder: string, mode: "current" | "new"): HTMLInputElement {
  return el("input", {
    type: "password",
    class: "gc-input",
    autocomplete: mode === "current" ? "current-password" : "new-password",
    autocapitalize: "none",
    spellcheck: false,
    inputmode: "text",
    placeholder: i18n.t(placeholder),
  }) as HTMLInputElement;
}

function profileSettings(i18n: I18n, lock: AppLockUiPort, status: HTMLElement): HTMLElement {
  const toggle = el("input", { type: "checkbox", class: "gc-toggle" }) as HTMLInputElement;
  toggle.checked = (lock.policy.profile ?? "default") === "paranoid";
  toggle.addEventListener("change", async () => {
    const profile = toggle.checked ? "paranoid" : "default";
    toggle.disabled = true;
    try {
      await lock.setProfile(profile);
      status.textContent = profile === "paranoid"
        ? i18n.t("lock.paranoidEnabled")
        : i18n.t("lock.paranoidDisabled");
    } catch {
      toggle.checked = (lock.policy.profile ?? "default") === "paranoid";
      status.textContent = i18n.t("lock.error");
    } finally {
      toggle.disabled = false;
    }
  });
  return el("div", { class: "gc-setting-list gc-lock-profile-settings" }, [
    el("label", { class: "gc-setting-row" }, [
      el("span", { class: "gc-setting-label" }, [i18n.t("lock.paranoid")]),
      toggle,
    ]),
    el("p", { class: "gc-settings-note" }, [i18n.t("lock.paranoidNote")]),
  ]);
}

function createDuressSettings(deps: LockSettingsDeps): HTMLElement {
  const { i18n, lock, status } = deps;
  const current = passwordInput(i18n, "lock.currentCode", "current");
  const code = passwordInput(i18n, "lock.duressCode", "new");
  const confirmation = passwordInput(i18n, "lock.confirmDuressCode", "new");
  const trustedUsername = el("input", {
    type: "text",
    class: "gc-input",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: false,
    placeholder: i18n.t("lock.trustedUsername"),
  }) as HTMLInputElement;
  const strength = el("p", { class: "gc-settings-note", role: "status", "aria-live": "polite" });
  code.addEventListener("input", () => {
    strength.textContent = code.value ? lockStrengthLabel(i18n, lock.estimate(code.value)) : "";
  });

  const save = el("button", { type: "button", class: "gc-btn" }, [
    i18n.t(lock.duress.enabled ? "lock.replaceDuress" : "lock.enableDuress"),
  ]);
  save.addEventListener("click", async () => {
    const estimate = lock.estimate(code.value);
    if (!estimate.valid) {
      status.textContent = lockStrengthLabel(i18n, estimate);
      return;
    }
    if (code.value !== confirmation.value) {
      status.textContent = i18n.t("lock.codeMismatch");
      return;
    }
    if (code.value === current.value) {
      status.textContent = i18n.t("lock.duressMustDiffer");
      return;
    }
    save.disabled = true;
    status.textContent = i18n.t("common.loading");
    try {
      await lock.configureDuress(current.value, code.value, trustedUsername.value.trim() || null);
      current.value = "";
      code.value = "";
      confirmation.value = "";
      trustedUsername.value = "";
      status.textContent = i18n.t("settings.saved");
      deps.rerender();
    } catch {
      status.textContent = i18n.t("lock.duressSaveError");
      save.disabled = false;
    }
  });

  const children: HTMLElement[] = [
    el("h3", { class: "gc-settings-subtitle" }, [i18n.t("lock.duressTitle")]),
    el("p", { class: "gc-settings-note" }, [i18n.t("lock.duressNote")]),
    el("p", { class: "gc-settings-note" }, [
      i18n.t(lock.duress.enabled ? "lock.duressEnabled" : "lock.duressDisabled"),
    ]),
    current,
    code,
    strength,
    confirmation,
    trustedUsername,
    el("p", { class: "gc-settings-note" }, [i18n.t("lock.trustedUsernameNote")]),
    save,
  ];

  if (lock.duress.enabled) {
    const removeCurrent = passwordInput(i18n, "lock.currentCode", "current");
    const remove = el("button", { type: "button", class: "gc-btn gc-btn-danger" }, [
      i18n.t("lock.disableDuress"),
    ]);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await lock.disableDuress(removeCurrent.value);
        status.textContent = i18n.t("settings.saved");
        deps.rerender();
      } catch {
        status.textContent = i18n.t("lock.wrongCurrentCode");
        remove.disabled = false;
      }
    });
    children.push(removeCurrent, remove);
  }

  return el("div", { class: "gc-setting-list gc-lock-duress-settings" }, children);
}

export function createLockSettings(deps: LockSettingsDeps): HTMLElement {
  const { i18n, lock, status } = deps;
  const section = el("section", { class: "gc-lock-settings" });
  section.append(
    el("h2", { class: "gc-settings-section-title" }, [i18n.t("lock.settingsTitle")]),
    el("p", { class: "gc-settings-note" }, [
      lock.enabled ? i18n.t("lock.settingsEnabled") : i18n.t("lock.settingsDisabled"),
    ]),
  );

  if (!lock.enabled) {
    const code = passwordInput(i18n, lock.policy.requirePassphrase ? "lock.passphrase" : "lock.newCode", "new");
    const confirmation = passwordInput(i18n, "lock.confirmCode", "new");
    const strength = el("p", { class: "gc-settings-note", role: "status", "aria-live": "polite" });




    const wipe = wipeSelect(i18n, lock.policy.wipeAfter);
    const enable = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("lock.enable")]);

    const updateStrength = (): void => {
      const estimate = lock.estimate(code.value);
      // V114: the idle hint has to describe the secret THIS device will accept. Where the app lock
      // fails closed (no hardware-backed key proven — see web/src/native_shell.ts) a six-digit code is
      // refused on submit, so advertising one only invites the refusal.
      const idleHint = lock.policy.requirePassphrase ? "lock.codeHintPassphrase" : "lock.codeHint";
      strength.textContent = code.value ? lockStrengthLabel(i18n, estimate) : i18n.t(idleHint);
      strength.dataset.score = String(estimate.score);
    };
    code.addEventListener("input", updateStrength);
    updateStrength();

    enable.addEventListener("click", async () => {
      const estimate = lock.estimate(code.value);
      if (!estimate.valid) {
        status.textContent = lockStrengthLabel(i18n, estimate);
        return;
      }
      if (code.value !== confirmation.value) {
        status.textContent = i18n.t("lock.codeMismatch");
        return;
      }
      enable.disabled = true;
      code.disabled = true;
      confirmation.disabled = true;
      status.textContent = i18n.t("lock.enabling");
      try {
        await lock.enable(code.value, {
          wipeAfter: wipe.value === "off" ? null : Number(wipe.value),
          requirePassphrase: lock.policy.requirePassphrase,
        });
        status.textContent = i18n.t("settings.saved");
        deps.rerender();
      } catch {
        status.textContent = i18n.t("lock.error");
        enable.disabled = false;
        code.disabled = false;
        confirmation.disabled = false;
      }
    });

    section.append(
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [i18n.t("lock.newCode")]),
        code,
      ]),
      strength,
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [i18n.t("lock.confirmCode")]),
        confirmation,
      ]),
      el("label", { class: "gc-setting-row" }, [
        el("span", { class: "gc-setting-label" }, [i18n.t("lock.wipeAfter")]),
        wipe,
      ]),
      el("p", { class: "gc-settings-note" }, [i18n.t("lock.enableWarning")]),
      enable,
    );
    return section;
  }

  const profileBlock = profileSettings(i18n, lock, status);

  const duressBlock = createDuressSettings(deps);

  const lockNow = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("lock.lockNow")]);
  lockNow.addEventListener("click", () => lock.lock());


  let biometricBlock: HTMLElement | null = null;
  if (lock.biometric.available) {
    const toggle = el("input", { type: "checkbox", class: "gc-toggle" }) as HTMLInputElement;
    toggle.checked = lock.biometric.enabled;
    toggle.addEventListener("change", async () => {
      const requested = toggle.checked;
      toggle.disabled = true;
      status.textContent = requested ? i18n.t("lock.biometricUnlocking") : i18n.t("common.loading");
      try {
        await lock.setBiometricEnabled(requested);
        toggle.checked = lock.biometric.enabled;
        status.textContent = lock.biometric.enabled
          ? i18n.t("lock.biometricEnabled")
          : i18n.t("lock.biometricDisabled");
      } catch (error) {
        toggle.checked = lock.biometric.enabled;
        const problem = typeof error === "object" && error !== null && "problem" in error
          ? String((error as { problem?: unknown }).problem)
          : "unavailable";
        status.textContent = problem === "cancelled"
          ? i18n.t("lock.biometricCancelled")
          : i18n.t("lock.biometricUnavailable");
      } finally {
        toggle.disabled = false;
      }
    });
    biometricBlock = el("div", { class: "gc-setting-list gc-lock-biometric-settings" }, [
      el("label", { class: "gc-setting-row" }, [
        el("span", { class: "gc-setting-label" }, [i18n.t("lock.biometric")]),
        toggle,
      ]),
      el("p", { class: "gc-settings-note" }, [i18n.t("lock.biometricNote")]),
    ]);
  }

  const wipe = wipeSelect(i18n, lock.policy.wipeAfter);
  wipe.addEventListener("change", async () => {
    wipe.disabled = true;
    try {
      await lock.setWipeAfter(wipe.value === "off" ? null : Number(wipe.value));
      status.textContent = i18n.t("settings.saved");
    } catch {
      status.textContent = i18n.t("lock.error");
    } finally {
      wipe.disabled = false;
    }
  });

  const current = passwordInput(i18n, "lock.currentCode", "current");
  const next = passwordInput(i18n, "lock.newCode", "new");
  const confirmation = passwordInput(i18n, "lock.confirmCode", "new");
  const strength = el("p", { class: "gc-settings-note", role: "status", "aria-live": "polite" });
  next.addEventListener("input", () => {
    strength.textContent = next.value ? lockStrengthLabel(i18n, lock.estimate(next.value)) : "";
  });
  const change = el("button", { type: "button", class: "gc-btn" }, [i18n.t("lock.changeCode")]);
  change.addEventListener("click", async () => {
    const estimate = lock.estimate(next.value);
    if (!estimate.valid) {
      status.textContent = lockStrengthLabel(i18n, estimate);
      return;
    }
    if (next.value !== confirmation.value) {
      status.textContent = i18n.t("lock.codeMismatch");
      return;
    }
    change.disabled = true;
    try {
      await lock.changeCode(current.value, next.value);
      current.value = "";
      next.value = "";
      confirmation.value = "";
      strength.textContent = "";
      status.textContent = i18n.t("settings.saved");
    } catch (error) {
      status.textContent = error instanceof Error && error.name === "DuressCodeConflictError"
        ? i18n.t("lock.duressMustDiffer")
        : i18n.t("lock.wrongCurrentCode");
    } finally {
      change.disabled = false;
    }
  });

  const disableCode = passwordInput(i18n, "lock.currentCode", "current");
  const disable = el("button", { type: "button", class: "gc-btn gc-btn-danger" }, [i18n.t("lock.disable")]);
  disable.addEventListener("click", async () => {
    disable.disabled = true;
    status.textContent = i18n.t("lock.disabling");
    try {
      await lock.disableAndWipe(disableCode.value);
      status.textContent = i18n.t("settings.saved");
      deps.rerender();
    } catch {
      status.textContent = i18n.t("lock.wrongCurrentCode");
      disable.disabled = false;
    }
  });

  section.append(
    lockNow,
    ...(biometricBlock ? [biometricBlock] : []),

    profileBlock,

    duressBlock,
    el("label", { class: "gc-setting-row" }, [
      el("span", { class: "gc-setting-label" }, [i18n.t("lock.wipeAfter")]),
      wipe,
    ]),
    el("h3", { class: "gc-settings-subtitle" }, [i18n.t("lock.changeCode")]),
    current,
    next,
    strength,
    confirmation,
    change,
    el("h3", { class: "gc-settings-subtitle" }, [i18n.t("lock.disable")]),
    el("p", { class: "gc-settings-note" }, [i18n.t("lock.disableWarning")]),
    disableCode,
    disable,
  );
  return section;
}
