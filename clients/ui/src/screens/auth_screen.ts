// clients/ui/src/screens/auth_screen.ts — the registration / sign-in screen (T-405, CLIENTS §10).
// A single card that toggles between "sign in" and "create account", runs the light client validation
// (auth_model.ts) before hitting the network, and drives the Session controller. Two server nuances are
// handled inline: TWO_FACTOR_REQUIRED reveals a TOTP field and re-submits; any other failure is turned
// into localised text via describeError. DOM-only (the testable logic lives in auth_model/session).
//
// Campaign 12 (owner report: "That username is already taken" with no clue which box was at fault):
//   * server errors that name exactly one input (USERNAME_TAKEN, EMAIL_TAKEN, …) are printed under
//     THAT input, which is focused and marked aria-invalid, instead of in the form-wide banner;
//   * field messages survive the re-render that follows a failed submit (they live in fieldMessages,
//     not in the throwaway DOM nodes) and are cleared as soon as the user edits the field;
//   * every sign-up field carries a short hint, the password gets a strength meter and a
//     show/hide button, and the consent gate says out loud why the button is still disabled.
import type { I18n } from "../i18n.ts";
import { QrLoginError, type QrLoginStatus, type Session } from "./session.ts";
import { el, clear } from "../dom.ts";
import { validateRegister, validateLogin, assessPassword, fieldForServerError, PASSWORD_STRENGTH_MAX } from "./auth_model.ts";
import type { AuthField, AuthFieldError, PasswordAssessment } from "./auth_model.ts";
import { apiErrorCode, describeError } from "./api.ts";
import { icon } from "../icons.ts";
import { createQrSvg } from "../qr.ts";

export interface AuthScreenDeps {
  session: Session;
  i18n: I18n;
  onAuthed: () => void;
  registration?: RegistrationModePort;
  /** Desktop shells expose QR sign-in; phones use the same route only to approve a scanned attempt. */
  allowQrLogin?: boolean;
}

export type RegistrationMode = "open" | "invite" | "closed";
export interface RegistrationModePort {
  get(): RegistrationMode;
  subscribe(listener: () => void): () => void;
}

type AuthMode = "login" | "register" | "qr";

const FIELD_ERR_KEY: Record<AuthFieldError, string> = {
  required: "auth.errRequired",
  password_short: "auth.errPasswordShort",
  email_invalid: "auth.errEmailInvalid",
  username_invalid: "auth.errUsernameInvalid",
};

// Indexed by PasswordAssessment.score (0…PASSWORD_STRENGTH_MAX). 0 only happens below the server
// minimum, where the note under the meter already says "at least 8 characters".
const STRENGTH_KEY = ["auth.pwWeak", "auth.pwWeak", "auth.pwFair", "auth.pwGood", "auth.pwStrong"] as const;
const STRENGTH_REASON_KEY: Record<NonNullable<PasswordAssessment["reason"]>, string> = {
  too_short: "auth.errPasswordShort",
  common: "auth.pwCommon",
  contains_username: "auth.pwContainsUsername",
};

// Unique per screen instance so aria-describedby never points at another screen's node.
let screenSeq = 0;

export function createAuthScreen(deps: AuthScreenDeps): { root: HTMLElement; destroy(): void } {
  const { session, i18n } = deps;
  let mode: AuthMode = "login";
  let need2fa = false;
  let busy = false;
  let passwordVisible = false;
  let activeSubmitButton: HTMLButtonElement | null = null;
  let qrController: AbortController | null = null;
  let qrLink: string | null = null;
  let qrExpiresAt = 0;
  let qrStatus: QrLoginStatus = "starting";
  let qrErrorKey: string | null = null;
  let qrCountdown: HTMLElement | null = null;
  let qrTicker: ReturnType<typeof setInterval> | null = null;
  let qrGeneration = 0;
  const uid = `gc-auth-${(screenSeq += 1)}`;

  // Persistent inputs — kept across re-renders so typed values and focus survive a mode toggle.
  // placeholder=" " is load-bearing, not decoration: it is what lets CSS tell an empty field from a
  // filled one (:placeholder-shown), which is how the floating label knows whether to sit inside the
  // box as a placeholder or ride up to a caption. A visible placeholder string would duplicate the
  // label and print two overlapping words in the same box.
  const mk = (type: string, autocomplete: string): HTMLInputElement => {
    const input = el("input", { type, class: "gc-input", autocomplete, placeholder: " " }) as HTMLInputElement;
    return input;
  };
  const usernameInput = mk("text", "username");
  const passwordInput = mk("password", "current-password");
  const nameInput = mk("text", "name");
  const emailInput = mk("email", "email");
  const totpInput = mk("text", "one-time-code");
  const inviteInput = mk("text", "one-time-code");
  const legalInput = el("input", { type: "checkbox", name: "legal_accepted" }) as HTMLInputElement;
  const ageInput = el("input", { type: "checkbox", name: "age_confirmed" }) as HTMLInputElement;

  const root = el("div", { class: "gc-auth" });
  const formError = el("p", { class: "gc-auth-error", role: "alert", "aria-live": "assertive" });

  // Per-field error state. The TEXT lives here, not in the DOM: a failed submit ends with a
  // re-render (busy → false), which rebuilds every error node, so a message written straight into
  // the old node would blink out. render() re-applies fieldMessages onto the fresh nodes.
  const fieldMessages: Partial<Record<AuthField, string>> = {};
  const fieldErrors: Partial<Record<AuthField, HTMLElement>> = {};
  const fieldInputs: Partial<Record<AuthField, HTMLInputElement>> = {};

  // Live nodes rebuilt by render(); null while the current mode does not show them.
  let revealButton: HTMLButtonElement | null = null;
  let strengthTrack: HTMLElement | null = null;
  let strengthText: HTMLElement | null = null;
  let strengthSegments: HTMLElement[] = [];
  let consentHint: HTMLElement | null = null;
  let focusAfterRender: AuthField | null = null;

  interface FieldOptions {
    hintKey?: string;
    required?: boolean;
    control?: HTMLElement; // wrapper around the input (password + reveal button)
    extra?: HTMLElement[]; // nodes between the control and the hint (strength meter)
  }

  // A field plate that carries its own label. Measured reason for the change (var/ux-audit/v50, the
  // 390x844 touch profile): the old layout stacked a caption row, a bare grey box, and a permanent
  // two-line hint paragraph per field, which made the sign-up card 1032 px tall on an 844 px screen —
  // the "Create account" button was never on screen without scrolling, and each of the four boxes was
  // an empty slab that said nothing about itself once the caption scrolled away. The label now lives
  // inside the plate and rides up to a caption as soon as the field is focused or filled, so the box
  // is self-describing and the form loses four caption rows.
  const boxed = (input: HTMLInputElement, labelText: string, control?: HTMLElement): HTMLElement =>
    el("span", { class: "gc-field-box" }, [
      control ?? input,
      // Not aria-hidden: the wrapping <label> derives the input's accessible name from exactly this
      // text, so hiding it from assistive tech would leave the field unnamed (WCAG 4.1.2).
      el("span", { class: "gc-field-label" }, [el("span", { class: "gc-field-name" }, [labelText])]),
    ]);

  // Per-field block: the labelled plate, an optional hint and the error line.
  const field = (labelKey: string, key: AuthField, input: HTMLInputElement, opts: FieldOptions = {}): HTMLElement => {
    const errId = `${uid}-${key}-err`;
    const hintId = `${uid}-${key}-hint`;
    const errLine = el("span", { class: "gc-field-err", id: errId });
    fieldErrors[key] = errLine;
    fieldInputs[key] = input;
    input.setAttribute("aria-describedby", opts.hintKey ? `${hintId} ${errId}` : errId);
    if (opts.required) input.setAttribute("aria-required", "true");
    else input.removeAttribute("aria-required");

    const message = fieldMessages[key];
    if (message) {
      errLine.textContent = message;
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }

    const children: HTMLElement[] = [boxed(input, i18n.t(labelKey), opts.control)];
    if (opts.extra) children.push(...opts.extra);
    if (opts.hintKey) children.push(el("span", { class: "gc-field-hint", id: hintId }, [i18n.t(opts.hintKey)]));
    children.push(errLine);
    return el("label", { class: "gc-field" }, children);
  };

  const plainField = (labelKey: string, input: HTMLInputElement): HTMLElement =>
    el("label", { class: "gc-field" }, [boxed(input, i18n.t(labelKey))]);

  const clearFieldError = (key: AuthField): void => {
    if (fieldMessages[key] === undefined) return;
    delete fieldMessages[key];
    const node = fieldErrors[key];
    if (node) node.textContent = "";
    fieldInputs[key]?.removeAttribute("aria-invalid");
  };

  const setFieldError = (key: AuthField, text: string): void => {
    fieldMessages[key] = text;
    const node = fieldErrors[key];
    if (node) node.textContent = text;
    fieldInputs[key]?.setAttribute("aria-invalid", "true");
  };

  const clearFieldErrors = (): void => {
    for (const key of Object.keys(fieldErrors) as AuthField[]) clearFieldError(key);
    formError.textContent = "";
  };

  const showFieldErrors = (errors: Partial<Record<AuthField, AuthFieldError>>): void => {
    for (const [k, code] of Object.entries(errors)) {
      if (code) setFieldError(k as AuthField, i18n.t(FIELD_ERR_KEY[code]));
    }
  };

  // ── Password: reveal toggle + strength meter ──────────────────────────────────────────────────
  const applyPasswordVisibility = (): void => {
    passwordInput.setAttribute("type", passwordVisible ? "text" : "password");
    const button = revealButton;
    if (!button) return;
    const label = i18n.t(passwordVisible ? "auth.hidePassword" : "auth.showPassword");
    button.setAttribute("aria-pressed", passwordVisible ? "true" : "false");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    clear(button);
    button.append(icon(passwordVisible ? "eyeOff" : "eye"));
  };

  const buildPasswordControl = (): HTMLElement => {
    const label = i18n.t(passwordVisible ? "auth.hidePassword" : "auth.showPassword");
    const button = el(
      "button",
      { type: "button", class: "gc-field-eye", "aria-pressed": passwordVisible, "aria-label": label, title: label },
      [icon(passwordVisible ? "eyeOff" : "eye")],
    ) as HTMLButtonElement;
    button.addEventListener("click", () => {
      passwordVisible = !passwordVisible;
      applyPasswordVisibility();
      passwordInput.focus();
    });
    revealButton = button;
    return el("div", { class: "gc-field-control" }, [passwordInput, button]);
  };

  const syncStrength = (): void => {
    const track = strengthTrack;
    const text = strengthText;
    if (!track || !text) return;
    const value = passwordInput.value;
    const { score, reason } = assessPassword(value, usernameInput.value);
    strengthSegments.forEach((seg, index) => {
      seg.setAttribute("class", index < score ? "gc-pw-seg is-on" : "gc-pw-seg");
    });
    track.setAttribute("data-score", String(score));
    if (value === "") {
      text.setAttribute("class", "gc-pw-text");
      text.textContent = i18n.t("auth.passwordHint");
      return;
    }
    const level = i18n.t(STRENGTH_KEY[score]);
    const note = reason ? i18n.t(STRENGTH_REASON_KEY[reason]) : "";
    text.setAttribute("class", score >= 3 ? "gc-pw-text is-strong" : "gc-pw-text");
    text.textContent = note
      ? `${i18n.t("auth.pwStrength")}: ${level} — ${note}`
      : `${i18n.t("auth.pwStrength")}: ${level}`;
  };

  const buildStrengthMeter = (): HTMLElement => {
    strengthSegments = [];
    for (let i = 0; i < PASSWORD_STRENGTH_MAX; i += 1) strengthSegments.push(el("span", { class: "gc-pw-seg" }));
    strengthTrack = el("div", { class: "gc-pw-track", "aria-hidden": true }, strengthSegments);
    strengthText = el("span", { class: "gc-pw-text", role: "status", "aria-live": "polite" });
    const meter = el("div", { class: "gc-pw" }, [strengthTrack, strengthText]);
    syncStrength();
    return meter;
  };

  const stopQrTicker = (): void => {
    if (qrTicker !== null) clearInterval(qrTicker);
    qrTicker = null;
    qrCountdown = null;
  };

  const syncQrCountdown = (): void => {
    const node = qrCountdown;
    if (!node || qrExpiresAt <= 0) return;
    const seconds = Math.max(0, Math.ceil((qrExpiresAt - Date.now()) / 1_000));
    node.textContent = i18n.t("auth.qrExpires", { seconds: String(seconds) });
  };

  const cancelQr = (): void => {
    qrGeneration += 1;
    qrController?.abort();
    qrController = null;
    stopQrTicker();
  };

  const startQr = async (): Promise<void> => {
    cancelQr();
    const generation = qrGeneration;
    const controller = new AbortController();
    qrController = controller;
    qrLink = null;
    qrExpiresAt = 0;
    qrStatus = "starting";
    qrErrorKey = null;
    busy = true;
    render();
    try {
      await session.loginWithQr({
        signal: controller.signal,
        onReady(attempt) {
          if (controller.signal.aborted || generation !== qrGeneration) return;
          qrLink = attempt.link;
          qrExpiresAt = attempt.expiresAt;
          qrStatus = "waiting";
          render();
        },
        onStatus(status) {
          if (controller.signal.aborted || generation !== qrGeneration) return;
          qrStatus = status;
          render();
        },
      });
      if (controller.signal.aborted || generation !== qrGeneration) return;
      qrController = null;
      stopQrTicker();
      deps.onAuthed();
    } catch (error) {
      if (controller.signal.aborted || generation !== qrGeneration) return;
      if (error instanceof QrLoginError) {
        qrErrorKey = error.code === "QR_DENIED"
          ? "auth.qrDenied"
          : error.code === "QR_EXPIRED"
            ? "auth.qrExpired"
            : error.code === "QR_CANCELLED"
              ? "auth.qrCancelled"
              : "auth.qrInvalid";
      } else {
        formError.textContent = describeError(error, i18n);
        qrErrorKey = "auth.qrNetwork";
      }
    } finally {
      if (generation === qrGeneration) {
        qrController = null;
        busy = false;
        stopQrTicker();
        render();
      }
    }
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    clearFieldErrors();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    const v =
      mode === "register"
        ? validateRegister({ username, password, name: nameInput.value.trim(), ...(emailInput.value.trim() ? { email: emailInput.value.trim() } : {}) })
        : validateLogin({ username, password });
    if (!v.valid) {
      showFieldErrors(v.errors);
      const first = (Object.keys(v.errors) as AuthField[])[0];
      if (first) fieldInputs[first]?.focus();
      return;
    }
    if (mode === "register" && (!legalInput.checked || !ageInput.checked)) {
      formError.textContent = i18n.t("auth.consentRequired");
      return;
    }

    busy = true;
    render();
    try {
      if (mode === "register") {
        const email = emailInput.value.trim();
        const invite = inviteInput.value.trim();
        await session.register({
          username,
          password,
          name: nameInput.value.trim(),
          legal_accepted: legalInput.checked,
          age_confirmed: ageInput.checked,
          ...(email ? { email } : {}),
          ...(invite ? { invite_code: invite } : {}),
        });
      } else {
        const totp = totpInput.value.trim();
        await session.login({ username, password, ...(need2fa && totp ? { totp_code: totp } : {}) });
      }
      deps.onAuthed();
    } catch (err) {
      // A first login without a code comes back TWO_FACTOR_REQUIRED → reveal the field and let the user retry.
      const code = apiErrorCode(err);
      if (code === "TWO_FACTOR_REQUIRED") {
        need2fa = true;
        busy = false;
        render();
        totpInput.focus();
        return;
      }
      const text = describeError(err, i18n);
      const target = fieldForServerError(code);
      // Only route to a field that this mode actually shows — otherwise the message would be
      // written into a node nobody renders (e.g. EMAIL_TAKEN while signing in).
      if (target && fieldErrors[target]) {
        setFieldError(target, text);
        focusAfterRender = target;
      } else {
        formError.textContent = text;
      }
    } finally {
      busy = false;
      render();
      if (focusAfterRender) {
        fieldInputs[focusAfterRender]?.focus();
        focusAfterRender = null;
      }
    }
  };

  const render = (): void => {
    clear(root);
    stopQrTicker();
    if (mode === "qr") {
      activeSubmitButton = null;
      const brand = el("div", { class: "gc-auth-brand" }, [
        el("span", { class: "gc-auth-brand-mark", "aria-hidden": true }, [icon("logo")]),
        el("span", { class: "gc-auth-brand-word" }, [i18n.t("common.appName")]),
      ]);
      const intro = el("div", { class: "gc-auth-intro" }, [
        el("h1", { class: "gc-auth-title" }, [i18n.t("auth.qrTitle")]),
        el("p", { class: "gc-auth-tagline" }, [i18n.t("auth.qrLead")]),
      ]);
      const content: HTMLElement[] = [];
      if (qrLink) {
        const qr = createQrSvg(qrLink, i18n.t("auth.qrLabel"));
        content.push(el("div", { class: "gc-connector-qr-frame" }, [qr]));
      }
      const statusKey = qrErrorKey ?? (
        qrStatus === "offline" ? "auth.qrOffline" :
        qrStatus === "starting" ? "auth.qrStarting" : "auth.qrWaiting"
      );
      content.push(el("p", { class: qrErrorKey ? "gc-auth-error" : "gc-auth-security", role: "status" }, [
        ...(qrErrorKey ? [] : [icon(qrStatus === "offline" ? "info" : "shield")]),
        el("span", {}, [i18n.t(statusKey)]),
      ]));
      if (qrExpiresAt > 0 && !qrErrorKey) {
        qrCountdown = el("p", { class: "gc-settings-note gc-auth-qr-countdown", role: "timer" });
        content.push(qrCountdown);
        syncQrCountdown();
        qrTicker = setInterval(syncQrCountdown, 1_000);
        (qrTicker as unknown as { unref?: () => void }).unref?.();
      }
      const refresh = el("button", {
        type: "button",
        class: "gc-btn gc-btn-accent gc-auth-qr-refresh",
        disabled: busy && !qrLink,
      }, [i18n.t(qrErrorKey ? "auth.qrTryAgain" : "auth.qrRefresh")]);
      refresh.addEventListener("click", () => void startQr());
      const back = el("button", { type: "button", class: "gc-link gc-auth-qr-back" }, [i18n.t("auth.qrBack")]);
      back.addEventListener("click", () => {
        cancelQr();
        qrLink = null;
        qrErrorKey = null;
        busy = false;
        mode = "login";
        render();
        usernameInput.focus();
      });
      content.push(refresh, back);
      root.append(
        el("div", { class: "gc-auth-atmosphere", "aria-hidden": true }),
        el("div", { class: "gc-auth-card gc-auth-qr-card" }, [brand, intro, ...content]),
      );
      return;
    }
    const isReg = mode === "register";
    // The password input persists across mode toggles, so re-point its autofill hint on every
    // render: "new-password" makes password managers offer to generate on sign-up instead of
    // filling the current secret (WCAG 1.3.5 / 3.3.8).
    passwordInput.setAttribute("autocomplete", isReg ? "new-password" : "current-password");
    const registration = deps.registration?.get() ?? "open";
    revealButton = null;
    strengthTrack = null;
    strengthText = null;
    strengthSegments = [];
    consentHint = null;

    const fields: HTMLElement[] = [
      field("auth.username", "username", usernameInput, {
        required: true,
        ...(isReg ? { hintKey: "auth.usernameHint" } : {}),
      }),
    ];
    if (isReg) fields.push(field("auth.name", "name", nameInput, { required: true, hintKey: "auth.nameHint" }));
    fields.push(
      field("auth.password", "password", passwordInput, {
        required: true,
        control: buildPasswordControl(),
        ...(isReg ? { extra: [buildStrengthMeter()] } : {}),
      }),
    );
    applyPasswordVisibility();
    if (isReg) fields.push(field("auth.emailOptional", "email", emailInput, { hintKey: "auth.emailHint" }));
    if (isReg && registration === "invite") fields.push(plainField("auth.inviteCode", inviteInput));
    if (isReg && registration !== "closed") {
      const tos = el("a", { href: "/legal/tos/", target: "_blank", rel: "noopener noreferrer" }, [i18n.t("auth.terms")]);
      const privacy = el("a", { href: "/legal/privacy/", target: "_blank", rel: "noopener noreferrer" }, [i18n.t("auth.privacy")]);
      fields.push(
        el("label", { class: "gc-check" }, [
          legalInput,
          el("span", { class: "gc-auth-legal-copy" }, [
            el("span", { class: "gc-auth-legal-prefix" }, [i18n.t("auth.acceptLegal")]),
            el("span", { class: "gc-auth-legal-actions" }, [
              tos,
              el("span", { class: "gc-auth-legal-and" }, [i18n.t("auth.and")]),
              privacy,
            ]),
          ]),
        ]),
        el("label", { class: "gc-check" }, [ageInput, el("span", {}, [i18n.t("auth.confirmAge")])]),
      );
      // Says out loud why the button below is still greyed out (WCAG 3.3.2): a disabled control is
      // skipped by screen readers, so the reason has to live outside it.
      consentHint = el("p", { class: "gc-auth-gate", id: `${uid}-gate`, role: "status" }, [
        icon("info"),
        el("span", {}, [i18n.t("auth.consentRequired")]),
      ]);
      fields.push(consentHint);
    }
    if (!isReg && need2fa) fields.push(plainField("auth.totp", totpInput));

    if (isReg && registration === "closed") {
      fields.push(el("p", { class: "gc-auth-error", role: "status" }, [i18n.t("auth.registrationClosed")]));
    }
    const gateBlocked = isReg && (registration === "closed" || !legalInput.checked || !ageInput.checked);
    const submitBtn = el(
      "button",
      {
        type: "submit",
        class: "gc-btn gc-btn-accent gc-auth-submit",
        disabled: busy || gateBlocked,
        ...(consentHint ? { "aria-describedby": `${uid}-gate` } : {}),
      },
      [
        busy
          ? i18n.t("auth.submitting")
          : isReg
            ? i18n.t("auth.signUp")
            : i18n.t("auth.signIn"),
      ],
    ) as HTMLButtonElement;
    activeSubmitButton = submitBtn;

    const form = el("form", { class: "gc-auth-form", novalidate: true }, [...fields, formError, submitBtn]);
    form.addEventListener("submit", (e) => { e.preventDefault(); void submit(); });

    const toggle = el("button", { type: "button", class: "gc-link" }, [
      isReg ? i18n.t("auth.haveAccount") : i18n.t("auth.noAccount"),
    ]);
    toggle.addEventListener("click", () => {
      mode = isReg ? "login" : "register";
      need2fa = false;
      clearFieldErrors();
      render();
      usernameInput.focus();
    });

    const footer: HTMLElement[] = [toggle];
    if (!isReg && deps.allowQrLogin) {
      const qrToggle = el("button", { type: "button", class: "gc-link gc-auth-qr-toggle" }, [
        i18n.t("auth.qrSignIn"),
      ]);
      qrToggle.addEventListener("click", () => {
        mode = "qr";
        need2fa = false;
        clearFieldErrors();
        render();
        void startQr();
      });
      footer.push(qrToggle);
    }
    const brand = el("div", { class: "gc-auth-brand" }, [
      el("span", { class: "gc-auth-brand-mark", "aria-hidden": true }, [icon("logo")]),
      el("span", { class: "gc-auth-brand-word" }, [i18n.t("common.appName")]),
    ]);
    const intro = el("div", { class: "gc-auth-intro" }, [
      el("h1", { class: "gc-auth-title" }, [i18n.t(isReg ? "auth.registerTitle" : "auth.welcomeTitle")]),
      el("p", { class: "gc-auth-tagline" }, [i18n.t(isReg ? "auth.registerLead" : "auth.welcomeLead")]),
    ]);
    const security = el("p", { class: "gc-auth-security" }, [
      icon("shield"),
      el("span", {}, [i18n.t("auth.securityNote")]),
    ]);

    syncConsentGate();
    root.append(
      el("div", { class: "gc-auth-atmosphere", "aria-hidden": true }),
      el("div", { class: "gc-auth-card" }, [brand, intro, form, ...footer, security]),
    );
  };

  const syncConsentGate = (): void => {
    if (mode !== "register") return;
    const registration = deps.registration?.get() ?? "open";
    const blocked = registration === "closed" || !legalInput.checked || !ageInput.checked;
    if (activeSubmitButton) activeSubmitButton.disabled = busy || blocked;
    if (consentHint) {
      if (blocked) consentHint.removeAttribute("hidden");
      else consentHint.setAttribute("hidden", "");
    }
  };
  legalInput.addEventListener("change", syncConsentGate);
  ageInput.addEventListener("change", syncConsentGate);
  // Typing in a field retracts its error the moment the user acts on it, and re-scores the
  // password (the username feeds the "don't put your handle in your password" check).
  for (const [key, input] of Object.entries({ username: usernameInput, password: passwordInput, name: nameInput, email: emailInput })) {
    input.addEventListener("input", () => {
      clearFieldError(key as AuthField);
      if (key === "password" || key === "username") syncStrength();
    });
  }
  render();
  const relocalise = i18n.subscribe(() => render());
  const registrationChanged =
    deps.registration?.subscribe(() => render()) ?? (() => {});
  return {
    root,
    destroy() {
      cancelQr();
      relocalise();
      registrationChanged();
    },
  };
}
