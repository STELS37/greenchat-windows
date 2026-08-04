// clients/ui/src/screens/attach_tray.ts — the compose-time attachment tray (T-407). Sits above the
// composer while files are staged: shows thumbnails, one Telegram-style "send as file" mode, remove
// controls and per-file progress. There is deliberately no quality selector: ordinary photo mode uses
// the product's balanced photo preset automatically; file mode sends the original bytes unchanged.
// The pure decisions (mime→kind, album-vs-individual, compression plan) live
// in media_model; the actual re-encode + upload live in media.ts. DOM-only; not node-tested.
import type { I18n } from "../i18n.ts";
import { el, clear } from "../dom.ts";
import { compressImage, type EncodedImage, type MediaPort } from "./media.ts";
import { sendKindForMime, albumEligible, formatBytes, progressPercent, type SendKind } from "./media_model.ts";
import { icon } from "../icons.ts";

export interface AttachTrayDeps {
  i18n: I18n;
  media: MediaPort;
  genCmid: () => string;
  // Called whenever the staged count changes 0↔N so the composer can flip its send button intent.
  onChange?: (count: number) => void;
}

export interface AttachTray {
  root: HTMLElement;
  add(files: FileList | File[]): void;
  count(): number;
  reset(): void;
  // Compress (images, per quality) + upload every staged file with progress, then return the ready
  // send bodies (one album body when eligible, else one per file; caption/reply ride the first). Throws
  // on upload failure — the caller surfaces the error and the tray keeps its items for a retry.
  flush(caption: string, replyToId: number | null): Promise<Array<Record<string, unknown>>>;
  destroy(): void;
}

interface Item {
  localId: string;
  file: File;
  previewUrl: string | null; // object URL of an image preview (revoked on remove/reset)
  bar: HTMLElement | null; // progress fill element while uploading
}

const ALBUM_CAP = 10;

export function createAttachTray(deps: AttachTrayDeps): AttachTray {
  const { i18n, media } = deps;
  let items: Item[] = [];
  let sendAsFile = false;
  // The files the send in progress owns. A tray stays fully interactive while it sends — that is the
  // whole reason it draws a progress bar — so "what is this send made of" has to be a fact of its
  // own rather than "whatever the array happens to hold when the loop next looks at it" (V156).
  const inFlight = new Set<string>();
  // …and, of those, the one whose bytes are on the wire this second. Uploads are strictly serial.
  let sendingId: string | null = null;
  // Sends are serialised through this chain. Every link is caught, so it never rejects and a failed
  // send cannot poison the ones after it.
  let queue: Promise<unknown> = Promise.resolve();

  const thumbs = el("div", { class: "gc-tray-thumbs" });
  const fileModeBtn = el("button", {
    type: "button",
    class: "gc-tray-file-mode",
    title: i18n.t("media.sendAsFile"),
    "aria-label": i18n.t("media.sendAsFile"),
    "aria-pressed": "false",
  }, [icon("attach"), el("span", { class: "gc-tray-file-mode-label" }, [i18n.t("media.sendAsFile")])]);
  const syncFileMode = (): void => {
    fileModeBtn.classList.toggle("is-on", sendAsFile);
    fileModeBtn.setAttribute("aria-pressed", String(sendAsFile));
  };
  fileModeBtn.addEventListener("click", () => { sendAsFile = !sendAsFile; syncFileMode(); });
  const root = el("div", { class: "gc-tray", hidden: true }, [
    thumbs,
    el("div", { class: "gc-tray-controls" }, [fileModeBtn]),
  ]);

  // How many files are WAITING to be sent. A file already committed to the send in progress is not
  // waiting for anything, and both consumers of this number ask it to decide what the person's NEXT
  // Enter means: composer.ts (`hasStaged` — permit an empty caption) and feed_screen.ts (`count() > 0`
  // → route the text in as a caption). While a batch uploaded, the old count reported it as staged, so
  // a message typed during the upload was handed to a send that had nothing left to attach it to and
  // was swallowed. Reporting only what is pending sends that text as text.
  const pending = (): number => items.reduce((n, it) => n + (inFlight.has(it.localId) ? 0 : 1), 0);
  // The tray itself stays VISIBLE while it uploads — the person is watching the progress bar — so
  // that question is asked of the whole list, not of the pending part.
  const notify = (): void => { root.hidden = items.length === 0; deps.onChange?.(pending()); };

  const renderThumb = (it: Item): HTMLElement => {
    // This file's bytes are already going out and MediaPort has no abort: its controls would be
    // lying if they still offered to withdraw it or to change how it is encoded. `disabled` also
    // takes them out of the Tab ring (a11y.ts), which says the same thing to a keyboard.
    const sending = it.localId === sendingId;
    const inner: Array<Node | string> = [];
    if (it.previewUrl) inner.push(el("img", { class: "gc-tray-img", src: it.previewUrl, alt: it.file.name }));
    else inner.push(el("span", { class: "gc-tray-fileicon" }, [icon("file")]));
    // The progress fill is created ONCE per file and reused by every later repaint. Building a fresh
    // one handed the item an empty bar at width 0 while its bytes kept climbing, so staging another
    // file — or toggling a neighbour's "send as file" — visibly threw the progress back to zero.
    const bar = it.bar ?? el("div", { class: "gc-tray-bar" });
    it.bar = bar;
    const rm = el("button", { type: "button", class: "gc-tray-rm", title: i18n.t("common.cancel"), disabled: sending }, [icon("close")]);
    rm.addEventListener("click", () => remove(it.localId));
    return el("div", {
      class: sending ? "gc-tray-thumb is-sending" : "gc-tray-thumb",
      title: `${it.file.name} · ${formatBytes(it.file.size)}`,
    }, [...inner, el("div", { class: "gc-tray-barwrap" }, [bar]), rm]);
  };

  const paint = (): void => {
    clear(thumbs);
    for (const it of items) thumbs.append(renderThumb(it));
  };

  // Drop a preview exactly once. The URL is nulled as it is revoked because the same item can be
  // reached twice — a send retiring its batch while destroy() unmounts the tray — and a second
  // revokeObjectURL() on a URL some other <img> has since been handed would blank a live thumbnail.
  const release = (list: Item[]): void => {
    for (const it of list) {
      if (it.previewUrl) { URL.revokeObjectURL(it.previewUrl); it.previewUrl = null; }
    }
  };

  const remove = (localId: string): void => {
    if (localId === sendingId) return; // already on the wire; its ✕ is disabled and says so
    const it = items.find((x) => x.localId === localId);
    if (!it) return;
    release([it]);
    items = items.filter((x) => x !== it);
    paint();
    notify();
  };

  const add = (files: FileList | File[]): void => {
    for (const file of Array.from(files)) {
      if (items.length >= ALBUM_CAP) break; // album cap; extra files are ignored (Telegram parity)
      const isImg = (file.type || "").startsWith("image/") && !(file.type || "").includes("svg");
      items.push({
        localId: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        previewUrl: isImg ? URL.createObjectURL(file) : null,
        bar: null,
      });
    }
    paint();
    notify();
  };

  // Queued, never refused. A second Send used to return [] outright because a send was in flight: the
  // caption typed for it was dropped on the floor and the caller was left showing "Загрузка…" for a
  // message it had never been given. Now it waits its turn and then sends whatever is staged by then.
  const flush = (caption: string, replyToId: number | null): Promise<Array<Record<string, unknown>>> => {
    const run = queue.then(() => sendBatch(caption, replyToId));
    queue = run.catch(() => {});
    return run;
  };

  const sendBatch = async (caption: string, replyToId: number | null): Promise<Array<Record<string, unknown>>> => {
    // The batch is fixed HERE, once, and everything below walks this list rather than `items`. The
    // loop used to walk the live array: a file picked while it ran joined the send already in
    // progress, under the previous message's caption and reply target, and was then swept away by
    // the reset() at the end — a file staged for the next message went out with the last one.
    const batch = items.slice();
    // Mode belongs to this press of Send. Changing the toolbar while bytes are already moving configures
    // the next staged batch; it can never rewrite the semantics of an in-flight message.
    const batchAsFile = sendAsFile;
    const sent: Item[] = [];
    const uploaded: Array<{ file_id: number; kind: SendKind }> = [];
    for (const it of batch) inFlight.add(it.localId);
    notify(); // this send owns them now, so nothing is left "staged" until something new is picked
    try {
      for (const it of batch) {
        // Withdrawn while an earlier file was uploading. The person meant it and nothing of this
        // file has left the device yet, so honour it: removing a thumbnail and sending the file
        // anyway is the one outcome that cannot be explained to anybody.
        if (!items.includes(it)) continue;
        sendingId = it.localId;
        paint();
        const prep: EncodedImage = batchAsFile
          ? { data: new Uint8Array(await it.file.arrayBuffer()), name: it.file.name, mime: it.file.type || "application/octet-stream" }
          : await compressImage(it.file, "balanced");
        const kind: SendKind = batchAsFile ? "file" : sendKindForMime(prep.mime);
        const up = await media.upload(prep.data, {
          name: prep.name,
          mime: prep.mime,
          onProgress: (l, t) => { if (it.bar) it.bar.style.width = `${progressPercent(l, t)}%`; },
          // V150: forward the size the encoder just measured so the receiver's bubble reserves the
          // picture's box and the conversation never jumps when it decodes. Absent for a file sent
          // verbatim (nothing decoded it) — the receiver then keeps the old free-height tile.
          ...(prep.width && prep.height ? { meta: { width: prep.width, height: prep.height } } : {}),
        });
        uploaded.push({ file_id: up.file_id, kind });
        sent.push(it);
      }
    } catch (err) {
      for (const it of batch) if (it.bar) it.bar.style.width = "0%";
      throw err;
    } finally {
      sendingId = null;
      inFlight.clear();
      paint(); // whatever is still staged is interactive again — including after a failure
      notify(); // …and a batch that failed counts as staged again, so Send can be pressed for it
    }
    const bodies = buildBodies(uploaded, caption, replyToId, deps.genCmid);
    discard(sent);
    return bodies;
  };

  // Retire exactly the files that were just sent and leave everything else — and its preview — alone.
  // reset() was called here instead, which threw away the files staged for the NEXT message too.
  const discard = (batch: Item[]): void => {
    if (batch.length === 0) return;
    release(batch);
    const gone = new Set(batch);
    items = items.filter((x) => !gone.has(x));
    if (items.length === 0) { sendAsFile = false; syncFileMode(); }
    paint();
    notify();
  };

  const reset = (): void => {
    release(items);
    items = [];
    sendAsFile = false;
    syncFileMode();
    clear(thumbs);
    notify();
  };

  return {
    root,
    add,
    count: pending,
    reset,
    flush,
    destroy() { reset(); },
  };
}

// Build the ready-to-enqueue send bodies from uploaded files: one album body (files[]) when eligible,
// else one message per file. The caption and reply target ride only the first body so history shows a
// single captioned group, matching how the server threads an album.
function buildBodies(
  uploaded: Array<{ file_id: number; kind: SendKind }>,
  caption: string,
  replyToId: number | null,
  genCmid: () => string,
): Array<Record<string, unknown>> {
  const text = caption.trim();
  if (albumEligible(uploaded.map((u) => u.kind))) {
    return [{
      client_msg_id: genCmid(),
      files: uploaded.map((u) => u.file_id),
      ...(text ? { text } : {}),
      ...(replyToId !== null ? { reply_to_id: replyToId } : {}),
    }];
  }
  return uploaded.map((u, i) => ({
    client_msg_id: genCmid(),
    file_id: u.file_id,
    kind: u.kind,
    ...(i === 0 && text ? { text } : {}),
    ...(i === 0 && replyToId !== null ? { reply_to_id: replyToId } : {}),
  }));
}
