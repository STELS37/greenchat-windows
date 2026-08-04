// clients/ui/src/screens/support_help_impl.ts — lazy implementation of the reusable support topic hub.
// initial Chats list and Settings → Help. Every ticket is an independent topic with its own status and
// public event trail. Inside a topic the user can continue with text, photo, video, audio or any file;
// the server mirrors each item into @support while retaining the ticket ref, so parallel requests never
// lose their context. All server data is rendered via textContent (el()); no innerHTML.
import type { I18n } from "../i18n.ts";
import type { ApiLike, SupportTicketSummary, SupportTicketList, SupportTicketDetail, SupportEvent } from "./api.ts";
import { el, clear } from "../dom.ts";
import { describeError } from "./api.ts";
import { categoryLabel, statusLabel, statusLine } from "./support_model.ts";
import { faqEntries } from "./support_faq.ts";
import { describeStatus, levelLabel, type SupportStatusPort, type StatusProbe, type StatusView } from "./support_status.ts";
import type { MediaPort } from "./media.ts";

// The bits the Settings screen must supply beyond api+i18n: how to leave for the @support dialog feed,
// (optionally) how to open the "contact support" form, and (optionally, T-514) the service-status probe
// that backs the "Состояние сервиса" card. Kept separate so Settings can gate the tab on it.
export interface SupportHelpPort {
  onOpenChat(chatId: number): void;
  onContact?(): void;
  status?: SupportStatusPort; // T-514 (MS-4 §3.1.3): client probe of GET /health + WS state; absent → no card.
}

export interface SupportHelpDeps extends SupportHelpPort {
  api: ApiLike;
  i18n: I18n;
  media?: Pick<MediaPort, "upload">;
}

export interface SupportHelpView {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

const PAGE = 50;

// T-514 (MS-4 §3.1.3): the static FAQ accordion. Pure content from the i18n catalogue (support_faq.ts);
// each entry is a <details> so the section stays compact. textContent only — no innerHTML.
function buildFaq(i18n: I18n): HTMLElement {
  const sec = el("section", { class: "gc-support-section gc-faq" }, [
    el("h3", { class: "gc-forward-title" }, [i18n.t("faq.title")]),
  ]);
  for (const e of faqEntries(i18n)) {
    sec.append(el("details", { class: "gc-faq-item" }, [
      el("summary", { class: "gc-faq-q" }, [e.q]),
      el("p", { class: "gc-faq-a" }, [e.a]),
    ]));
  }
  return sec;
}

function eventPayload(ev: SupportEvent): Record<string, unknown> {
  return ev.payload && typeof ev.payload === "object" && !Array.isArray(ev.payload)
    ? ev.payload as Record<string, unknown>
    : {};
}

// A public event → one readable topic line. Message events include their text or attached-file name,
// which makes a ticket usable as an actual conversation instead of a status-only audit trail.
function eventLine(i18n: I18n, ev: SupportEvent): string {
  const payload = eventPayload(ev);
  if (ev.kind === "status") {
    const to = payload.to;
    if (typeof to === "string") return `→ ${statusLabel(i18n, to)}`;
  }
  if (ev.kind === "message") {
    const actor = ev.actor === "user" ? i18n.t("chat.previewYou") : i18n.t("support.help");
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const fileName = typeof payload.file_name === "string" ? payload.file_name.trim() : "";
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    const body = [text, fileName ? `📎 ${fileName}` : kind ? `📎 ${kind}` : ""].filter(Boolean).join(" · ");
    return body ? `${actor}: ${body}` : `${actor}: ${i18n.t("support.ticketMessage")}`;
  }
  return ev.kind;
}

export function createSupportHelpImpl(deps: SupportHelpDeps, hostRoot?: HTMLElement): SupportHelpView {
  const { api, i18n } = deps;
  let disposed = false;
  let tickets: SupportTicketSummary[] = [];
  let nextBefore: number | null = null;
  let viewGeneration = 0; // invalidates a lazy composer if the user navigates away while it loads

  const root = hostRoot ?? el("div", { class: "gc-support-help" });
  const status = el("p", { class: "gc-settings-status", role: "status", "aria-live": "polite" });
  const body = el("div", {});
  // T-514: a service-status card (only when a probe port is supplied) + the static FAQ, below the tickets.
  const statusCard = el("section", { class: "gc-support-section gc-status-card" });
  const faqSection = buildFaq(i18n);
  root.append(status, body);
  if (deps.status) root.append(statusCard);
  root.append(faqSection);

  const setStatus = (text: string): void => { status.textContent = text; };

  // ---- service status (T-514, MS-4 §3.1.3 / §14) ----------------------------------------------------
  // A CLIENT probe — GET /health (raw, via the injected port) + the live SyncEngine WS state + online +
  // offline-queue length. No new server endpoint. paintStatus repaints the card from a StatusView;
  // probeStatus samples the four inputs (health is async) and repaints, guarded by `disposed`.
  const paintStatus = (view: StatusView): void => {
    clear(statusCard);
    statusCard.className = `gc-support-section gc-status-card gc-status-${view.level}`;
    const refresh = el("button", { type: "button", class: "gc-btn gc-status-refresh" }, [i18n.t("status.refresh")]);
    refresh.addEventListener("click", () => void probeStatus());
    statusCard.append(
      el("div", { class: "gc-status-head" }, [
        el("span", { class: "gc-status-dot", "aria-hidden": "true" }),
        el("h3", { class: "gc-forward-title" }, [i18n.t("status.title")]),
        refresh,
      ]),
      el("p", { class: "gc-status-level" }, [levelLabel(view.level, i18n)]),
    );
    const rows = el("dl", { class: "gc-status-rows" }, [
      el("div", {}, [el("dt", {}, [i18n.t("status.server.label")]), el("dd", {}, [view.server])]),
      el("div", {}, [el("dt", {}, [i18n.t("status.connection.label")]), el("dd", {}, [view.connection])]),
    ]);
    if (view.uptime) rows.append(el("div", {}, [el("dt", {}, [i18n.t("status.uptime.label")]), el("dd", {}, [view.uptime])]));
    statusCard.append(rows);
    if (view.queued) statusCard.append(el("p", { class: "gc-status-queued" }, [view.queued]));
  };

  // Neutral placeholder while the first (or a manual) probe is in flight — avoids flashing a red "down"
  // card before /health answers.
  const paintChecking = (): void => {
    clear(statusCard);
    statusCard.className = "gc-support-section gc-status-card gc-status-checking";
    const refresh = el("button", { type: "button", class: "gc-btn gc-status-refresh" }, [i18n.t("status.refresh")]);
    refresh.addEventListener("click", () => void probeStatus());
    statusCard.append(
      el("div", { class: "gc-status-head" }, [
        el("span", { class: "gc-status-dot", "aria-hidden": "true" }),
        el("h3", { class: "gc-forward-title" }, [i18n.t("status.title")]),
        refresh,
      ]),
      el("p", { class: "gc-status-level" }, [i18n.t("status.checking")]),
    );
  };

  const probeStatus = async (): Promise<void> => {
    const port = deps.status;
    if (!port) return;
    let health: StatusProbe["health"] = null;
    try { health = await port.health(); } catch { health = null; }
    if (disposed) return;
    const probe: StatusProbe = { online: port.online(), health, ws: port.wsState(), queued: port.queued() };
    paintStatus(describeStatus(probe, i18n));
  };

  // ---- list -----------------------------------------------------------------------------------------
  const renderList = (): void => {
    viewGeneration += 1;
    clear(body);
    const head = el("div", { class: "gc-support-actions gc-support-actions-head" }, [
      el("h3", { class: "gc-forward-title" }, [i18n.t("support.myTickets")]),
    ]);
    if (deps.onContact) {
      const contact = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("support.contact")]);
      contact.addEventListener("click", () => deps.onContact?.());
      head.append(contact);
    }
    body.append(head);

    if (tickets.length === 0) {
      body.append(el("p", { class: "gc-support-hint" }, [i18n.t("support.noTickets")]));
      return;
    }

    const list = el("div", { class: "gc-support-tickets", role: "list", "aria-label": i18n.t("support.myTickets") });
    for (const t of tickets) {
      const row = el("button", {
        type: "button",
        class: "gc-support-ticket",
        role: "listitem",
        "data-topic-ref": t.ref,
      }, [
        el("span", {}, [`${t.ref} · ${categoryLabel(i18n, t.category)}`]),
        el("span", { class: "gc-support-badge" }, [statusLabel(i18n, t.status)]),
      ]);
      row.addEventListener("click", () => void openDetail(t.ref));
      list.append(row);
    }
    body.append(list);

    if (nextBefore !== null) {
      const more = el("button", { type: "button", class: "gc-btn" }, [i18n.t("common.loadMore")]);
      more.addEventListener("click", () => void load(nextBefore));
      body.append(more);
    }
  };

  // ---- detail ---------------------------------------------------------------------------------------
  const renderDetail = (d: SupportTicketDetail): void => {
    const generation = ++viewGeneration;
    clear(body);
    const back = el("button", { type: "button", class: "gc-btn" }, [i18n.t("common.back")]);
    back.addEventListener("click", () => renderList());
    body.append(back);

    body.append(
      el("h3", { class: "gc-forward-title" }, [`${d.ref} · ${categoryLabel(i18n, d.category)}`]),
      el("p", { class: "gc-support-badge" }, [statusLine(i18n, d.ref, d.status)]),
      el("p", { class: "gc-support-detail-text" }, [d.text]),
    );

    if (d.events.length > 0) {
      const evs = el("ul", { class: "gc-support-events", role: "log", "aria-live": "polite" });
      for (const ev of d.events) {
        evs.append(el("li", {
          class: "gc-support-event",
          "data-event-kind": ev.kind,
          "data-event-actor": ev.actor,
        }, [eventLine(i18n, ev)]));
      }
      body.append(el("p", { class: "gc-field-label" }, [i18n.t("support.events")]), evs);
    }
    // The upload/reply machinery is a lazy chunk: most app starts never open an active support topic,
    // so it must not tax the initial messenger shell. A generation guard prevents a late import from
    // appending into the ticket list after the person has already pressed Back.
    if (d.status !== "closed") {
      const slot = el("div", { "data-support-composer-slot": d.ref });
      body.append(slot);
      void import("./support_topic_composer.ts").then(({ createSupportTopicComposer }) => {
        if (disposed || generation !== viewGeneration) return;
        slot.append(createSupportTopicComposer({
          api,
          i18n,
          ticket: d,
          ...(deps.media ? { media: deps.media } : {}),
          isDisposed: () => disposed || generation !== viewGeneration,
          refresh: () => openDetail(d.ref),
        }));
      }).catch((err: unknown) => {
        if (!disposed && generation === viewGeneration) setStatus(describeError(err, i18n));
      });
    }

    // The ordinary @support dialog remains available as a compatibility/history surface. New replies
    // should be sent through the topic composer above so text and media stay attached to the right ref.
    if (d.chat_id !== null) {
      const open = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("support.openDialog")]);
      open.addEventListener("click", () => deps.onOpenChat(d.chat_id as number));
      body.append(open);
    }
  };

  const openDetail = async (ref: string): Promise<void> => {
    const getTicket = api.getSupportTicket?.bind(api);
    if (!getTicket) return;
    setStatus(i18n.t("common.loading"));
    try {
      const d = await getTicket(ref);
      if (disposed) return;
      setStatus("");
      renderDetail(d);
    } catch (err) {
      if (disposed) return;
      setStatus(describeError(err, i18n));
    }
  };

  // ---- load -----------------------------------------------------------------------------------------
  const load = async (before: number | null): Promise<void> => {
    const listTickets = api.listSupportTickets?.bind(api);
    if (!listTickets) { renderList(); return; }
    setStatus(i18n.t("common.loading"));
    try {
      const res: SupportTicketList = before === null ? await listTickets(PAGE) : await listTickets(PAGE, before);
      if (disposed) return;
      setStatus("");
      tickets = before === null ? res.tickets : [...tickets, ...res.tickets];
      nextBefore = res.next_before_id;
      renderList();
    } catch (err) {
      if (disposed) return;
      setStatus(describeError(err, i18n));
    }
  };

  const refresh = (): void => {
    tickets = []; nextBefore = null;
    void load(null);
    if (deps.status) { paintChecking(); void probeStatus(); }
  };
  refresh();

  return { root, refresh, destroy() { disposed = true; } };
}
