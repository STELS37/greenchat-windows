import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import type { ApiLike, SearchUser } from "./api.ts";
import { describeError } from "./api.ts";
import type { AccountDeletionResult } from "./session.ts";
import {
  SafetyControlError,
  blockUserByUsername,
  loadBlockedUsers,
  unblockUser,
} from "./safety_model.ts";
import { failureState, stateView } from "./state_view.ts";

export interface SafetyScreenDeps {
  api: ApiLike;
  i18n: I18n;
  selfId: number;
  onReport?: () => void;
  deleteAccount: (password: string) => Promise<AccountDeletionResult>;
}

export interface SafetyScreen {
  root: HTMLElement;
  destroy(): void;
}

// Settings may remount Safety while a prior view still owns an in-flight block mutation. Keep the
// mutation tail on the shared transport identity so every replacement view waits before its first
// authoritative GET and cannot paint a stale pre-mutation snapshot.
const mutationTails = new WeakMap<ApiLike, Promise<void>>();

function serializeMutation<T>(
  api: ApiLike,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(api);
  // Preserve the existing immediate start for an uncontended action; only followers wait in the queue.
  // That also attaches rejection handling to an already-started resolver before a view can be destroyed.
  const result = previous ? previous.then(mutation) : mutation();
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(api, tail);
  void tail.then(() => {
    if (mutationTails.get(api) === tail) mutationTails.delete(api);
  });
  return result;
}

function waitForMutations(api: ApiLike): Promise<void> {
  return mutationTails.get(api) ?? Promise.resolve();
}

export function createSafetyScreen(deps: SafetyScreenDeps): SafetyScreen {
  const { api, i18n } = deps;
  let disposed = false;
  let blocked: SearchUser[] = [];
  let blockedLoaded = false;
  // Set when the block list could not be READ. Kept apart from the status line, which reports
  // writes: a failed read has to be answered inside the list, where the missing rows are.
  let loadError: unknown = null;
  let busy = false;
  let operationGeneration = 0;
  const lifecycle = new AbortController();
  const isCurrent = (generation: number): boolean =>
    !disposed && generation === operationGeneration;

  const root = el("div", { class: "gc-safety" });
  const status = el("p", {
    class: "gc-settings-status",
    role: "status",
    "aria-live": "polite",
  });
  const list = el("div", { class: "gc-safety-list" });
  const username = el("input", {
    type: "text",
    class: "gc-input",
    autocomplete: "off",
    placeholder: i18n.t("report.usernamePlaceholder"),
    "aria-label": i18n.t("safety.usernameLabel"),
  }) as HTMLInputElement;
  const blockButton = el("button", { type: "button", class: "gc-btn" }, [
    i18n.t("safety.block"),
  ]) as HTMLButtonElement;
  const actionButtons = new Set<HTMLButtonElement>([blockButton]);
  const unblockButtons = new Set<HTMLButtonElement>();

  const errorText = (error: unknown): string => {
    if (error instanceof SafetyControlError)
      return i18n.t(`safety.error.${error.code}`);
    return describeError(error, i18n);
  };

  const renderBlocked = (): void => {
    clear(list);
    unblockButtons.clear();
    // A read that failed is not an empty list. Until V160 this branch was missing, so a lost
    // connection drew zero children: the screen said "nobody is blocked" by drawing nothing, while
    // «Заблокировать» stayed disabled forever (blockedLoaded === false) with nothing offering a
    // retry. The failure belongs where the rows would have been.
    if (loadError) {
      list.append(
        loadError instanceof SafetyControlError
          // Appendix-D wording for a response we did reach but could not trust; it names the list.
          ? stateView({
            tone: "error",
            icon: "warning",
            title: i18n.t("state.errorTitle"),
            body: errorText(loadError),
            actionLabel: i18n.t("common.retry"),
            onAction: () => void load(),
          })
          : failureState(loadError, i18n, () => void load()),
      );
      return;
    }
    if (blocked.length === 0) {
      list.append(
        el("p", { class: "gc-settings-note" }, [i18n.t("safety.noneBlocked")]),
      );
      return;
    }
    for (const user of blocked) {
      const unblock = el(
        "button",
        { type: "button", class: "gc-btn gc-btn-small" },
        [i18n.t("safety.unblock")],
      ) as HTMLButtonElement;
      unblockButtons.add(unblock);
      unblock.disabled = busy;
      unblock.addEventListener("click", async () => {
        if (busy || disposed) return;
        const generation = ++operationGeneration;
        setBusy(true);
        status.textContent = "";
        try {
          await serializeMutation(api, () =>
            unblockUser(api, user.id, lifecycle.signal),
          );
          if (!isCurrent(generation)) return;
          blocked = blocked.filter((candidate) => candidate.id !== user.id);
          renderBlocked();
          status.textContent = i18n.t("safety.unblocked", {
            username: user.username,
          });
        } catch (error) {
          if (!isCurrent(generation)) return;
          status.textContent = errorText(error);
        } finally {
          if (isCurrent(generation)) setBusy(false);
        }
      });
      list.append(
        el("div", { class: "gc-safety-user" }, [
          el("span", { class: "gc-safety-user-copy" }, [
            el("strong", {}, [user.name || `@${user.username}`]),
            el("small", {}, [
              `@${user.username}${user.is_bot ? ` · ${i18n.t("safety.bot")}` : ""}`,
            ]),
          ]),
          unblock,
        ]),
      );
    }
  };

  const load = async (): Promise<void> => {
    const generation = ++operationGeneration;
    setBusy(true);
    status.textContent = i18n.t("common.loading");
    try {
      await waitForMutations(api);
      if (!isCurrent(generation)) return;
      const nextBlocked = await loadBlockedUsers(api);
      if (!isCurrent(generation)) return;
      blocked = nextBlocked;
      blockedLoaded = true;
      loadError = null;
      status.textContent = "";
      renderBlocked();
    } catch (error) {
      if (isCurrent(generation)) {
        blockedLoaded = false;
        loadError = error;
        // The block itself carries the message and the retry, and it is role="status" too — leaving
        // the same text in the status line would announce the failure twice.
        status.textContent = "";
        renderBlocked();
      }
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  };

  blockButton.addEventListener("click", async () => {
    if (busy || disposed) return;
    const generation = ++operationGeneration;
    setBusy(true);
    status.textContent = "";
    try {
      const rawUsername = username.value;
      const user = await serializeMutation(api, () =>
        blockUserByUsername(
          api,
          rawUsername,
          deps.selfId,
          lifecycle.signal,
        ),
      );
      if (!isCurrent(generation)) return;
      if (!blocked.some((candidate) => candidate.id === user.id))
        blocked = [...blocked, user];
      username.value = "";
      renderBlocked();
      status.textContent = i18n.t("safety.blocked", {
        username: user.username,
      });
    } catch (error) {
      if (!isCurrent(generation)) return;
      status.textContent = errorText(error);
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  });

  const moderationActions: HTMLElement[] = [];
  if (deps.onReport) {
    const report = el(
      "button",
      { type: "button", class: "gc-btn gc-btn-accent" },
      [i18n.t("safety.report")],
    ) as HTMLButtonElement;
    actionButtons.add(report);
    report.addEventListener("click", () => {
      if (!disposed) deps.onReport?.();
    });
    moderationActions.push(report);
  }

  const password = el("input", {
    type: "password",
    class: "gc-input",
    autocomplete: "current-password",
    "aria-label": i18n.t("safety.deletePassword"),
  }) as HTMLInputElement;
  const acknowledge = el("input", { type: "checkbox" }) as HTMLInputElement;
  const deleteButton = el(
    "button",
    { type: "button", class: "gc-btn gc-btn-danger" },
    [i18n.t("safety.deleteAction")],
  ) as HTMLButtonElement;
  actionButtons.add(deleteButton);
  const syncControls = (): void => {
    username.disabled = busy;
    password.disabled = busy;
    acknowledge.disabled = busy;
    for (const button of actionButtons) button.disabled = busy;
    for (const button of unblockButtons) button.disabled = busy;
    blockButton.disabled = busy || !blockedLoaded;
    deleteButton.disabled =
      busy || password.value.length === 0 || !acknowledge.checked;
  };
  const setBusy = (next: boolean): void => {
    busy = next;
    syncControls();
  };
  password.addEventListener("input", syncControls);
  acknowledge.addEventListener("change", syncControls);
  deleteButton.addEventListener("click", async () => {
    if (
      busy ||
      disposed ||
      password.value.length === 0 ||
      !acknowledge.checked
    )
      return;
    const generation = ++operationGeneration;
    setBusy(true);
    status.textContent = "";
    try {
      await deps.deleteAccount(password.value);
      if (!isCurrent(generation)) return;
    } catch (error) {
      if (!isCurrent(generation)) return;
      status.textContent = describeError(error, i18n);
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  });
  syncControls();

  root.append(
    status,
    el("section", { class: "gc-safety-section" }, [
      el("h2", {}, [i18n.t("safety.moderationTitle")]),
      el("p", { class: "gc-settings-note" }, [
        i18n.t("safety.moderationIntro"),
      ]),
      el("div", { class: "gc-safety-actions" }, moderationActions),
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [
          i18n.t("safety.usernameLabel"),
        ]),
        username,
      ]),
      blockButton,
      el("h3", {}, [i18n.t("safety.blockedTitle")]),
      list,
    ]),
    el("section", { class: "gc-safety-section gc-safety-danger" }, [
      el("h2", {}, [i18n.t("safety.deleteTitle")]),
      el("p", { class: "gc-settings-note" }, [i18n.t("safety.deleteIntro")]),
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [
          i18n.t("safety.deletePassword"),
        ]),
        password,
      ]),
      el("label", { class: "gc-safety-confirm" }, [
        acknowledge,
        i18n.t("safety.deleteConfirm"),
      ]),
      deleteButton,
    ]),
  );
  void load();

  return {
    root,
    destroy() {
      disposed = true;
      operationGeneration += 1;
      lifecycle.abort();
    },
  };
}
