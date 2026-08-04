// clients/ui/src/screens/contacts_screen.ts — the «Контакты» shell destination.
//
// V178 keeps the acquisition actions first-class but removes the oversized promotional hero. The
// compact action list now behaves like a native address-book surface at narrow mobile widths while
// preserving private phonebook sync, invite sharing, directory search and the actual contact list.
// The native boundary returns only SHA-256 hashes; names and phone numbers never enter the WebView.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon, type IconName } from "../icons.ts";
import { apiErrorCode, apiErrorData, describeError, type ApiLike, type SearchUser } from "./api.ts";
import { createContactsCopy } from "./contacts_copy.ts";
import { failureLine, failureState, skeletonList, stateView } from "./state_view.ts";
import { avatarTone, initials } from "./message_menu.ts";
import { SearchController, type SearchState, type SelfRef } from "./new_chat_model.ts";
import { isServiceAccount, serviceAccountLabel } from "./service_account.ts";
import {
  addContact,
  addableUsers,
  contactSubtitle,
  contactTitle,
  filterContacts,
  isContactsLimit,
  loadContacts,
  removeContact,
  upsertContactInServerOrder,
  type ContactRow,
} from "./contacts_model.ts";
import {
  ContactsGrowthError,
  inviteProfileUrl,
  parseAddressBookScan,
  readBrowserAddressBook,
  syncAddressBook,
  type AddressBookBridge,
  type AddressBookScan,
} from "./contacts_growth_model.ts";

interface GrowthWindow extends Window {
  __gcAddressBook?: AddressBookBridge;
  __gcServerOrigin?: string;
}

interface BrowserContactsNavigator extends Navigator {
  contacts?: { select(properties: string[], options: { multiple: boolean }): Promise<Array<{ tel?: string[] }>> };
}

export interface ContactsScreenDeps {
  api: ApiLike;
  i18n: I18n;
  self: SelfRef;
  onBack(): void;
  onOpenChat(chatId: number): void;
  atShellRoot?: boolean;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  // Test/platform seams. Production resolves these from the native bridge or browser capabilities.
  addressBook?: AddressBookBridge | null;
  publicOrigin?: string;
  share?: (data: ShareData) => Promise<void>;
  copyText?: (text: string) => Promise<void>;
}

export function createContactsScreen(deps: ContactsScreenDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const t = createContactsCopy(i18n);
  let disposed = false;
  let loadEpoch = 0;
  let dialogEpoch = 0;
  let hasSnapshot = false;
  let contacts: ContactRow[] = [];
  let query = "";
  let directory: SearchState = { phase: "idle" };
  let syncBusy = false;
  let inviteBusy = false;
  const pending = new Set<number>();

  const win = (typeof window === "undefined" ? undefined : window) as GrowthWindow | undefined;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const addressBook = deps.addressBook === undefined ? win?.__gcAddressBook : deps.addressBook ?? undefined;
  const publicOrigin = deps.publicOrigin
    ?? win?.__gcServerOrigin
    ?? (typeof location === "undefined" ? "" : location.origin);
  const profileUrl = inviteProfileUrl(deps.self, publicOrigin);
  const inviteText = t("contacts.inviteText", { url: profileUrl });
  const share = deps.share ?? (typeof nav?.share === "function" ? nav.share.bind(nav) : undefined);
  const copyText = deps.copyText ?? (nav?.clipboard?.writeText ? nav.clipboard.writeText.bind(nav.clipboard) : undefined);

  const back = el("button", {
    type: "button",
    class: "gc-icon-btn",
    title: t("common.back"),
    "aria-label": t("common.back"),
  }, [icon("back")]);
  back.addEventListener("click", deps.onBack);
  const refresh = el("button", {
    type: "button",
    class: "gc-icon-btn",
    title: t("common.retry"),
    "aria-label": t("common.retry"),
  }, [icon("refresh")]);
  const header = el("header", { class: "gc-calls-header" }, [
    ...(deps.atShellRoot === true ? [] : [back]),
    el("div", { class: "gc-calls-heading" }, [
      el("h1", {}, [t("contacts.title")]),
      el("p", {}, [t("contacts.subtitle")]),
    ]),
    refresh,
  ]);
  const status = el("p", { class: "gc-calls-status", role: "status", "aria-live": "polite" });

  const input = el("input", {
    type: "search",
    class: "gc-chats-search-input",
    autocomplete: "off",
    placeholder: t("contacts.searchPlaceholder"),
    "aria-label": t("contacts.searchPlaceholder"),
  }) as HTMLInputElement;
  const searchBox = el("div", { class: "gc-chats-search gc-contacts-search" }, [
    el("span", { class: "gc-chats-search-icon", "aria-hidden": true }, [icon("search")]),
    input,
  ]);

  const syncDetail = el("p", {
    class: "gc-contact-growth-result",
    role: "status",
    "aria-live": "polite",
  });
  syncDetail.hidden = true;

  const growthButton = (
    glyph: IconName,
    title: string,
    lead: string,
    kind: "primary" | "secondary" | "quiet",
    run: () => void,
  ): HTMLButtonElement => {
    const btn = el("button", {
      type: "button",
      class: `gc-contact-growth-action gc-contact-growth-action-${kind}`,
    }, [
      el("span", { class: "gc-contact-growth-action-icon", "aria-hidden": true }, [icon(glyph)]),
      el("span", { class: "gc-contact-growth-action-copy" }, [
        el("strong", {}, [title]),
        el("small", {}, [lead]),
      ]),
      el("span", { class: "gc-contact-growth-chevron", "aria-hidden": true }, [icon("chevron")]),
    ]) as HTMLButtonElement;
    btn.addEventListener("click", run);
    return btn;
  };

  let syncButton: HTMLButtonElement;
  let inviteButton: HTMLButtonElement;
  const growth = el("section", { class: "gc-contact-growth", "aria-labelledby": "gc-contact-growth-title" }, [
    el("div", { class: "gc-contact-growth-head" }, [
      el("div", { class: "gc-contact-growth-copy" }, [
        el("h2", { id: "gc-contact-growth-title" }, [t("contacts.growthTitle")]),
        el("p", {}, [t("contacts.growthLead")]),
      ]),
    ]),
    el("div", { class: "gc-contact-growth-actions" }, [
      syncButton = growthButton(
        "refresh",
        t("contacts.syncAction"),
        t("contacts.syncActionLead"),
        "primary",
        () => { void onSync(); },
      ),
      inviteButton = growthButton(
        "send",
        t("contacts.inviteAction"),
        t("contacts.inviteActionLead"),
        "secondary",
        () => { void onInvite(); },
      ),
      growthButton(
        "copy",
        t("contacts.copyAction"),
        t("contacts.copyActionLead"),
        "quiet",
        () => { void onCopyLink(); },
      ),
    ]),
    el("div", { class: "gc-contact-growth-privacy" }, [
      icon("shield"),
      el("span", {}, [t("contacts.privacyNote")]),
    ]),
    syncDetail,
  ]);

  const listHost = el("div", { class: "gc-contacts-host" }, [skeletonList(5)]);
  const body = el("main", { class: "gc-calls-body gc-contacts-body", "aria-busy": "true" }, [
    searchBox,
    growth,
    listHost,
  ]);
  const root = el("div", { class: "gc-calls gc-contacts" }, [header, status, body]);

  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text.length === 0;
  };
  const sayGrowth = (text: string, tone: "ok" | "info" | "error" = "info"): void => {
    syncDetail.textContent = text;
    syncDetail.hidden = text.length === 0;
    syncDetail.setAttribute("data-tone", tone);
  };
  const setBusy = (button: HTMLButtonElement, busy: boolean): void => {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  };
  const commitMutation = (): void => {
    loadEpoch += 1;
    body.setAttribute("aria-busy", "false");
  };

  const personRow = (
    opts: { id: number; title: string; subtitle: string; service: boolean; action: HTMLElement | null },
  ): HTMLElement => {
    const top: Array<Node | string> = [el("span", { class: "gc-row-title" }, [opts.title])];
    if (opts.service) top.push(el("span", { class: "gc-badge gc-badge-service" }, [serviceAccountLabel(i18n)]));
    const open = el("button", {
      type: "button",
      class: "gc-chat-open",
      "aria-label": t("contacts.openChat", { name: opts.title }),
    }, [
      el("div", { class: "gc-row-top" }, top),
      opts.subtitle
        ? el("div", { class: "gc-row-bottom" }, [el("span", { class: "gc-row-sub" }, [opts.subtitle])])
        : "",
    ]) as HTMLButtonElement;
    if (api.createDialog) open.addEventListener("click", () => void openDialog(opts.id, open));
    else open.disabled = true;
    const children: Array<HTMLElement> = [
      el("div", { class: "gc-avatar", "data-tone": String(avatarTone(opts.title)), "aria-hidden": true }, [
        initials(opts.title),
      ]),
      open,
    ];
    if (opts.action) children.push(opts.action);
    return el("div", { class: "gc-chat-row", role: "listitem" }, children);
  };

  const iconAction = (glyph: "plus" | "trash", label: string, run: () => void): HTMLButtonElement => {
    const btn = el("button", { type: "button", class: "gc-icon-btn", title: label, "aria-label": label }, [
      icon(glyph),
    ]) as HTMLButtonElement;
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); run(); });
    return btn;
  };

  const openDialog = async (userId: number, trigger: HTMLButtonElement): Promise<void> => {
    if (!api.createDialog || pending.has(userId)) return;
    const epoch = ++dialogEpoch;
    pending.add(userId);
    trigger.disabled = true;
    try {
      const chat = await api.createDialog(userId);
      if (disposed || epoch !== dialogEpoch) return;
      deps.onOpenChat(chat.id);
    } catch (err) {
      if (disposed || epoch !== dialogEpoch) return;
      say(describeError(err, i18n));
    } finally {
      pending.delete(userId);
      trigger.disabled = false;
    }
  };

  const onAdd = async (user: SearchUser): Promise<void> => {
    if (pending.has(user.id)) return;
    pending.add(user.id);
    try {
      const row = await addContact(api, user.id);
      if (disposed) return;
      commitMutation();
      contacts = upsertContactInServerOrder(contacts, row);
      say(t("contacts.added", { name: contactTitle(row) }));
      render();
    } catch (err) {
      if (disposed) return;
      say(isContactsLimit(err) ? t("contacts.limit") : describeError(err, i18n));
    } finally {
      pending.delete(user.id);
    }
  };

  const onRemove = async (row: ContactRow): Promise<void> => {
    if (pending.has(row.id)) return;
    pending.add(row.id);
    try {
      await removeContact(api, row.id);
      if (disposed) return;
      commitMutation();
      contacts = contacts.filter((c) => c.id !== row.id);
      say(t("contacts.removed", { name: contactTitle(row) }));
      render();
    } catch (err) {
      if (disposed) return;
      say(describeError(err, i18n));
    } finally {
      pending.delete(row.id);
    }
  };

  const readPhonebook = async (): Promise<AddressBookScan> => {
    if (addressBook) return parseAddressBookScan(await addressBook.readHashes());
    const contactsApi = (nav as BrowserContactsNavigator | undefined)?.contacts;
    return readBrowserAddressBook(contactsApi, typeof crypto === "undefined" ? undefined : crypto);
  };

  async function onSync(): Promise<void> {
    if (syncBusy) return;
    syncBusy = true;
    setBusy(syncButton, true);
    sayGrowth(t("contacts.syncReading"));
    try {
      const scan = await readPhonebook();
      if (disposed) return;
      if (scan.hashes.length === 0) {
        sayGrowth(t("contacts.syncNoNumbers"), "info");
        return;
      }
      sayGrowth(t("contacts.syncChecking", { count: String(scan.hashes.length) }));
      const summary = await syncAddressBook(api, scan);
      if (disposed) return;
      if (summary.addedCount > 0) {
        commitMutation();
        const rows = await loadContacts(api);
        if (disposed) return;
        contacts = rows;
        hasSnapshot = true;
        render();
      }
      const key = summary.addedCount > 0
        ? "contacts.syncAdded"
        : summary.matched.length > 0
          ? "contacts.syncAlready"
          : "contacts.syncNobody";
      let result = t(key, {
        added: String(summary.addedCount),
        checked: String(summary.checked),
      });
      if (scan.skipped_numbers > 0) {
        result += " " + t("contacts.syncSkipped", { count: String(scan.skipped_numbers) });
      }
      if (scan.truncated) result += " " + t("contacts.syncTruncated");
      sayGrowth(result, summary.addedCount > 0 ? "ok" : "info");
      say(contacts.length ? t("contacts.count", { count: String(contacts.length) }) : "");
    } catch (err) {
      if (disposed) return;
      const denied = err instanceof Error && /PERMISSION_DENIED|permission denied|denied/i.test(err.message);
      const unsupported = err instanceof ContactsGrowthError && err.code === "unsupported";
      const rateLimited = apiErrorCode(err) === "RATE_LIMITED";
      const retryAfter = apiErrorData(err).retry_after;
      const retryAfterSeconds = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : 3600;
      const message = denied
        ? t("contacts.syncPermissionDenied")
        : unsupported
          ? t("contacts.syncUnsupported")
          : rateLimited
            ? t("contacts.syncRateLimited", { minutes: String(Math.max(1, Math.ceil(retryAfterSeconds / 60))) })
            : t("contacts.syncFailed");
      sayGrowth(message, "error");
    } finally {
      syncBusy = false;
      setBusy(syncButton, false);
    }
  }

  async function onInvite(): Promise<void> {
    if (inviteBusy) return;
    inviteBusy = true;
    setBusy(inviteButton, true);
    try {
      if (addressBook) {
        const result = await addressBook.inviteBySms(inviteText);
        if (!disposed && result.opened) sayGrowth(t("contacts.inviteOpened"), "ok");
        return;
      }
      if (share) {
        await share({ title: t("contacts.inviteShareTitle"), text: inviteText, url: profileUrl });
        if (!disposed) sayGrowth(t("contacts.inviteShared"), "ok");
        return;
      }
      await onCopyLink();
    } catch (err) {
      // User cancellation is not a product failure and should not replace a previous useful result.
      if (!disposed && !(err instanceof Error && /abort|cancel/i.test(err.name + " " + err.message))) {
        sayGrowth(t("contacts.inviteFailed"), "error");
      }
    } finally {
      inviteBusy = false;
      setBusy(inviteButton, false);
    }
  }

  async function onCopyLink(): Promise<void> {
    if (!copyText) {
      if (share) {
        try {
          await share({ title: t("contacts.inviteShareTitle"), text: inviteText, url: profileUrl });
          if (!disposed) sayGrowth(t("contacts.inviteShared"), "ok");
          return;
        } catch (err) {
          if (err instanceof Error && /abort|cancel/i.test(err.name + " " + err.message)) return;
        }
      }
      sayGrowth(t("contacts.copyFailed"), "error");
      return;
    }
    try {
      await copyText(profileUrl);
      if (!disposed) sayGrowth(t("contacts.linkCopied"), "ok");
    } catch {
      if (!disposed) sayGrowth(t("contacts.copyFailed"), "error");
    }
  }

  const renderContacts = (): HTMLElement => {
    const rows = filterContacts(contacts, query);
    const section = el("section", { class: "gc-calls-section gc-contacts-section" }, [
      el("div", { class: "gc-section-heading" }, [
        el("h2", {}, [t("contacts.mine")]),
        el("span", {}, [contacts.length ? String(contacts.length) : ""]),
      ]),
    ]);
    if (contacts.length === 0) {
      const emptySearch = el("button", { type: "button", class: "gc-contacts-empty-search" }, [
        t("contacts.emptyAction"),
      ]);
      emptySearch.addEventListener("click", () => input.focus());
      section.append(el("div", { class: "gc-contacts-empty-compact", role: "status" }, [
        el("span", { class: "gc-contacts-empty-icon", "aria-hidden": true }, [icon("users")]),
        el("div", { class: "gc-contacts-empty-copy" }, [
          el("strong", {}, [t("contacts.empty")]),
          el("span", {}, [t("contacts.emptyLead")]),
        ]),
        emptySearch,
      ]));
      return section;
    }
    if (rows.length === 0) {
      section.append(stateView({
        tone: "empty",
        icon: "search",
        title: t("contacts.noMatches"),
        body: t("contacts.noMatchesLead"),
      }));
      return section;
    }
    const list = el("div", { class: "gc-contacts-list", role: "list" });
    for (const row of rows) {
      const title = contactTitle(row);
      list.append(personRow({
        id: row.id,
        title,
        subtitle: contactSubtitle(row),
        service: false,
        action: iconAction("trash", t("contacts.remove", { name: title }), () => { void onRemove(row); }),
      }));
    }
    section.append(list);
    return section;
  };

  const renderDirectory = (): HTMLElement | null => {
    if (!api.searchGlobal) return null;
    if (directory.phase === "idle" && query.trim().length === 0) return null;
    const section = el("section", { class: "gc-calls-section gc-contacts-found" }, [
      el("div", { class: "gc-section-heading" }, [
        el("h2", {}, [t("contacts.found")]),
        el("span", {}, [t("contacts.foundHint")]),
      ]),
    ]);
    if (directory.phase === "idle") {
      section.append(el("p", { class: "gc-contacts-hint" }, [t("contacts.searchHint")]));
      return section;
    }
    if (directory.phase === "loading") {
      section.append(el("p", { class: "gc-contacts-hint" }, [t("common.loading")]));
      return section;
    }
    if (directory.phase === "error") {
      section.append(failureState(directory.error, i18n, () => ctrl.input(input.value)));
      return section;
    }
    const users = directory.phase === "results" ? addableUsers(directory.users, contacts, deps.self.id) : [];
    if (users.length === 0) {
      const already = directory.phase === "results";
      section.append(stateView({
        tone: "empty",
        icon: "search",
        title: t(already ? "contacts.allAdded" : "contacts.notFound"),
        body: t(already ? "contacts.allAddedLead" : "contacts.notFoundLead"),
      }));
      return section;
    }
    const list = el("div", { class: "gc-contacts-list", role: "list" });
    for (const user of users) {
      const title = user.name || user.username || String(user.id);
      list.append(personRow({
        id: user.id,
        title,
        subtitle: user.username ? "@" + user.username : "",
        service: isServiceAccount(user),
        action: iconAction("plus", t("contacts.add", { name: title }), () => { void onAdd(user); }),
      }));
    }
    section.append(list);
    return section;
  };

  const render = (): void => {
    clear(listHost);
    listHost.append(renderContacts());
    const found = renderDirectory();
    if (found) listHost.append(found);
  };

  const ctrl = new SearchController({
    search: async (q) => (await api.searchGlobal?.(q))?.users ?? [],
    onState: (state) => {
      if (disposed) return;
      directory = state;
      if (hasSnapshot) render();
    },
    setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
  });

  input.addEventListener("input", () => {
    query = input.value;
    ctrl.input(query);
    if (hasSnapshot) render();
  });

  const load = async (): Promise<void> => {
    const epoch = ++loadEpoch;
    body.setAttribute("aria-busy", "true");
    say(t("common.loading"));
    if (!hasSnapshot) { clear(listHost); listHost.append(skeletonList(5)); }
    try {
      const rows = await loadContacts(api);
      if (disposed || epoch !== loadEpoch) return;
      contacts = rows;
      hasSnapshot = true;
      render();
      say(rows.length ? t("contacts.count", { count: String(rows.length) }) : "");
      body.setAttribute("aria-busy", "false");
    } catch (err) {
      if (disposed || epoch !== loadEpoch) return;
      body.setAttribute("aria-busy", "false");
      if (hasSnapshot) {
        say(failureLine(err, i18n));
        return;
      }
      clear(listHost);
      listHost.append(failureState(err, i18n, () => { void load(); }));
      say("");
    }
  };

  refresh.addEventListener("click", () => void load());
  void load();

  return {
    root,
    destroy() {
      disposed = true;
      ctrl.cancel();
    },
  };
}
