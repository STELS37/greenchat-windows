// clients/ui/src/screens/reconsent_screen.ts — the BLOCKING legal re-consent screen (legal v2).
//
// Mounted by the app shell when the legal gate (reconsent_model.ts) says consent is owed: the
// documents changed after this account's last acceptance, so nothing else may run until the person
// decides on the NEW edition. The contract:
//   • the CURRENT documents are fetched and shown inline (GET /v1/legal/tos|privacy — public), plus
//     the same target=_blank links the registration form uses (auth_screen pattern);
//   • an explicit checkbox arms the accept button — the same deliberate gesture as registration;
//   • accept POSTs /v1/legal/accept with `version` = current_version FROM THE STATUS RESPONSE — the
//     edition this render actually displayed, never a constant — so an operator bump between display
//     and click cannot stamp consent to unseen text (the server refuses: 403 + writes NOTHING);
//   • on that 403 the screen re-fetches status+documents and asks again over the NEW text; the tick
//     resets and there is NO automatic retry — the next accept is a fresh human decision;
//   • decline = sign out (the shell wires session.logout()) — refusing must never silently continue.
// Markdown is rendered as plain pre-wrapped text via textContent (CLIENTS §10: never innerHTML).
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import type { ApiLike, LegalAccepted, LegalDoc, LegalStatus } from "./api.ts";
import { apiErrorCode, describeError } from "./api.ts";
import { parseLegalStatus } from "./reconsent_model.ts";

export interface ReconsentScreenDeps {
  api: ApiLike;
  i18n: I18n;
  // The consent position that made the shell block (the gate's status at mount time).
  status: LegalStatus;
  onAccepted(): void;
  onDecline(): void;
}

export interface ReconsentFailureScreenDeps {
  i18n: I18n;
  error: unknown;
  onRetry(): void;
  onDecline(): void;
}
export function createReconsentFailureScreen(
  deps: ReconsentFailureScreenDeps,
): { root: HTMLElement; destroy(): void } {
  const retry = el("button", { type: "button", class: "gc-btn gc-btn-accent gc-reconsent-retry" }, [
    deps.i18n.t("common.retry"),
  ]);
  const decline = el("button", { type: "button", class: "gc-btn gc-reconsent-decline" }, [
    deps.i18n.t("reconsent.decline"),
  ]);
  retry.addEventListener("click", () => deps.onRetry());
  decline.addEventListener("click", () => deps.onDecline());
  const root = el("main", {
    class: "gc-auth gc-reconsent gc-reconsent-error",
    "aria-label": deps.i18n.t("reconsent.title"),
  }, [
    el("section", { class: "gc-auth-card gc-reconsent-card" }, [
      el("h1", { class: "gc-auth-title" }, [deps.i18n.t("reconsent.title")]),
      el("p", { class: "gc-auth-tagline" }, [deps.i18n.t("reconsent.subtitle")]),
      el("p", { class: "gc-auth-error", role: "alert", "aria-live": "assertive" }, [
        `${deps.i18n.t("reconsent.loadError")}: ${describeError(deps.error, deps.i18n)}`,
      ]),
      el("div", { class: "gc-reconsent-actions" }, [
        retry,
        decline,
      ]),
      el("p", { class: "gc-auth-tagline gc-reconsent-hint" }, [deps.i18n.t("reconsent.declineHint")]),
    ]),
  ]);
  return { root, destroy() { clear(root); } };
}
function parseLegalDoc(value: unknown, expectedDoc: "tos" | "privacy", expectedVersion: number): LegalDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid legal document payload");
  }
  const row = value as Record<string, unknown>;
  if (
    row["doc"] !== expectedDoc ||
    row["version"] !== expectedVersion ||
    typeof row["markdown"] !== "string" ||
    row["markdown"].trim().length === 0
  ) {
    throw new Error("legal document does not match the displayed edition");
  }
  return { doc: expectedDoc, version: expectedVersion, markdown: row["markdown"] };
}

const DOCS = ["tos", "privacy"] as const;

export function createReconsentScreen(deps: ReconsentScreenDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  let status = deps.status;
  let disposed = false;
  const root = el("main", { class: "gc-auth gc-reconsent", "aria-label": i18n.t("reconsent.title") });

  const fetchStatus = (): Promise<unknown> =>
    api.getLegalStatus ? api.getLegalStatus() : api.get<unknown>("/v1/legal/status");
  const postAccept = (version: number): Promise<LegalAccepted> =>
    api.acceptLegal
      ? api.acceptLegal(version)
      : api.post<LegalAccepted>("/v1/legal/accept", { legal_accepted: true, version });

  const card = (children: Array<HTMLElement | string>): void => {
    clear(root);
    root.append(
      el("section", { class: "gc-auth-card gc-reconsent-card" }, [
        el("h1", { class: "gc-auth-title" }, [i18n.t("reconsent.title")]),
        el("p", { class: "gc-auth-tagline" }, [i18n.t("reconsent.subtitle")]),
        ...children,
      ]),
    );
  };

  const renderLoading = (): void => {
    card([el("p", { class: "gc-reconsent-loading", role: "status" }, [i18n.t("common.loading")])]);
  };

  const renderLoadError = (err: unknown): void => {
    const retry = el("button", { type: "button", class: "gc-btn gc-reconsent-retry" }, [i18n.t("common.retry")]);
    retry.addEventListener("click", () => load(true, null));
    card([
      el("p", { class: "gc-auth-error", role: "alert", "aria-live": "assertive" }, [
        `${i18n.t("reconsent.loadError")}: ${describeError(err, i18n)}`,
      ]),
      retry,
      declineButton(),
    ]);
  };

  const declineButton = (): HTMLButtonElement => {
    const b = el("button", { type: "button", class: "gc-btn gc-reconsent-decline" }, [
      i18n.t("reconsent.decline"),
    ]) as HTMLButtonElement;
    b.addEventListener("click", () => deps.onDecline());
    return b;
  };

  const renderReady = (docs: LegalDoc[], notice: string | null): void => {
    const agree = el("input", { type: "checkbox", name: "legal_accepted" }) as HTMLInputElement;
    const error = el("p", { class: "gc-auth-error", role: "alert", "aria-live": "assertive" }, notice ? [notice] : []);
    const accept = el("button", { type: "button", class: "gc-btn gc-btn-accent gc-reconsent-accept", disabled: true }, [
      i18n.t("reconsent.accept"),
    ]) as HTMLButtonElement;
    const decline = declineButton();
    agree.addEventListener("change", () => { accept.disabled = !agree.checked; });

    accept.addEventListener("click", () => {
      if (!agree.checked) return;
      const version = status.current_version; // the edition THIS render displayed — from status, no constant
      accept.disabled = true;
      decline.disabled = true;
      agree.disabled = true;
      error.textContent = "";
      void (async () => {
        try {
          await postAccept(version);
          if (!disposed) deps.onAccepted();
        } catch (err) {
          if (disposed) return;
          if (apiErrorCode(err) === "LEGAL_RECONSENT") {
            // The edition moved between display and click. Fetch the NEW position + documents and ask
            // again from an unticked box — never auto-accept text the person hasn't seen.
            load(true, i18n.error("LEGAL_RECONSENT"));
            return;
          }
          error.textContent = describeError(err, i18n);
          accept.disabled = !agree.checked;
          decline.disabled = false;
          agree.disabled = false;
        }
      })();
    });

    // The same consent sentence (and public links) the registration form shows — one vocabulary.
    const tos = el("a", { href: "/legal/tos/", target: "_blank", rel: "noopener noreferrer" }, [i18n.t("auth.terms")]);
    const privacy = el("a", { href: "/legal/privacy/", target: "_blank", rel: "noopener noreferrer" }, [i18n.t("auth.privacy")]);
    card([
      ...docs.map((d) =>
        el("section", { class: "gc-reconsent-docblock" }, [
          el("h2", { class: "gc-reconsent-doc-title" }, [
            i18n.t(d.doc === "tos" ? "reconsent.tos" : "reconsent.privacy"),
            ` — ${i18n.t("reconsent.edition", { version: d.version })}`,
          ]),
          el("div", { class: "gc-reconsent-doc" }, [
            d.markdown,
          ]),
        ]),
      ),
      el("label", { class: "gc-check" }, [
        agree,
        el("span", {}, [i18n.t("auth.acceptLegal"), " ", tos, " ", i18n.t("auth.and"), " ", privacy]),
      ]),
      error,
      el("div", { class: "gc-reconsent-actions" }, [
        accept,
        decline,
      ]),
      el("p", { class: "gc-auth-tagline gc-reconsent-hint" }, [i18n.t("reconsent.declineHint")]),
    ]);
  };

  // refreshStatus=true re-reads the consent position first (used after a 403 and on retry, where the
  // edition we blocked on may already be stale); `notice` carries the human reason for the re-ask.
  const load = (refreshStatus: boolean, notice: string | null): void => {
    renderLoading();
    void (async () => {
      try {
        if (refreshStatus) status = parseLegalStatus(await fetchStatus());
        const expectedVersion = status.current_version;
        const docs = await Promise.all(DOCS.map(async (docName) =>
          parseLegalDoc(await api.get<unknown>(`/v1/legal/${docName}`), docName, expectedVersion),
        ));
        if (!disposed) renderReady(docs, notice);
      } catch (err) {
        if (!disposed) renderLoadError(err);
      }
    })();
  };

  load(false, null);

  return {
    root,
    destroy() {
      disposed = true;
      clear(root);
    },
  };
}
