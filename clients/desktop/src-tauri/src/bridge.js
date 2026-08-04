// T-411 desktop bridge — injected into the SHARED web bundle before its own scripts run.
// The web app is byte-for-byte the PWA build; this shim rewires four seams to native services
// WITHOUT forking the frontend. It uses only the global `__TAURI__` core API (withGlobalTauri).
(function () {
  "use strict";
  var T = window.__TAURI__;
  if (!T || !T.core) return; // running in a plain browser — no-op, the PWA behaves normally
  var invoke = T.core.invoke;

  // Native identity is injected by Rust before this script is parsed. Keep `platform:"desktop"` for
  // the existing telemetry/server contract, while exposing the real OS and architecture so an installed
  // Linux program creates a distinct device session and can be diagnosed independently from browser tabs.
  var NATIVE_OS = __GC_DESKTOP_OS__;
  var NATIVE_ARCH = __GC_DESKTOP_ARCH__;
  var NATIVE_VERSION = __GC_DESKTOP_VERSION__;
  var CLIENT_HEADER = "desktop/" + NATIVE_VERSION;
  var OS_LABEL = NATIVE_OS === "linux" ? "Linux" : NATIVE_OS === "windows" ? "Windows" : NATIVE_OS === "macos" ? "macOS" : "Desktop";
  var DEVICE_HEADER = "GreenChat Desktop " + OS_LABEL + " " + NATIVE_ARCH + " " + NATIVE_VERSION;
  var DESKTOP_NOTIFY_PREF = "gc.desktop.notifications.enabled";
  var notificationEnabled = false; // explicit local opt-in; enabling is what triggers the OS prompt
  var pendingNotificationChatId = null;
  try { notificationEnabled = window.localStorage.getItem(DESKTOP_NOTIFY_PREF) === "1"; } catch (_) {}
  function persistNotificationEnabled(on) {
    notificationEnabled = on === true;
    try { window.localStorage.setItem(DESKTOP_NOTIFY_PREF, notificationEnabled ? "1" : "0"); } catch (_) {}
  }
  function permissionGranted(state) { return String(state || "").toLowerCase() === "granted"; }
  window.__GC_NATIVE = {
    platform: "desktop",
    os: NATIVE_OS,
    architecture: NATIVE_ARCH,
    appVersion: NATIVE_VERSION,
    deviceLabel: DEVICE_HEADER,
    identity: function () { return invoke("desktop_identity"); },
    takeCrashes: function () { return invoke("take_native_crashes"); },
    desktopSystem: {
      getNotifications: function () {
        if (!notificationEnabled) return Promise.resolve(false);
        return invoke("notification_permission").then(permissionGranted);
      },
      setNotifications: function (on) {
        if (on !== true) { persistNotificationEnabled(false); return Promise.resolve(); }
        return invoke("request_notification_permission").then(function (state) {
          if (!permissionGranted(state)) throw new Error("desktop notification permission denied");
          persistNotificationEnabled(true);
        });
      },
      getAutostart: function () { return invoke("autostart_get").then(function (v) { return v === true; }); },
      setAutostart: function (on) { return invoke("autostart_set", { enabled: on === true }); },
    },
    notifications: {
      markChat: function (chatId) {
        var id = Number(chatId);
        pendingNotificationChatId = Number.isInteger(id) && id > 0 ? id : null;
      },
    },
  };

  // 0) Server origin + native request identity. A packaged Tauri application has a tauri:// origin,
  // not an HTTP server. Rust always injects either GC_SERVER or the canonical production origin, and this
  // shim rewrites only GreenChat API traffic. It also replaces the shared web bundle's `web/<version>`
  // header with `desktop/<version>` and adds X-Device, so every Linux installation receives its own
  // recognisable session in Settings → Devices.
  var ORIGIN = __GC_SERVER_ORIGIN__;
  var api = String(ORIGIN || "").replace(/\/+$/, "");
  var apiOrigin = api ? new URL(api).origin : "";
  var _fetch = window.fetch.bind(window);

  function apiRequest(value) {
    var raw = typeof value === "string" ? value : value && value.toString ? value.toString() : "";
    if (!raw) return null;
    if (raw === "/v1" || raw.indexOf("/v1/") === 0) return { url: api + raw, native: true };
    try {
      var parsed = new URL(raw, window.location.href);
      if (parsed.pathname !== "/v1" && parsed.pathname.indexOf("/v1/") !== 0) return null;
      if (parsed.protocol === "tauri:" || parsed.origin === window.location.origin) {
        return { url: api + parsed.pathname + parsed.search + parsed.hash, native: true };
      }
      if (apiOrigin && parsed.origin === apiOrigin) return { url: parsed.toString(), native: true };
      return null;
    } catch (_) {
      return null;
    }
  }

  window.fetch = function (input, init) {
    try {
      var raw = typeof input === "string" || input instanceof URL ? String(input) : input && input.url;
      var routed = apiRequest(raw);
      if (!routed || !api) return _fetch(input, init);
      var sourceHeaders = init && init.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
      var headers = new Headers(sourceHeaders);
      headers.set("x-gc-client", CLIENT_HEADER);
      headers.set("x-device", DEVICE_HEADER);
      var nextInit = Object.assign({}, init || {}, { headers: headers });
      if (input instanceof Request) return _fetch(new Request(routed.url, input), nextInit);
      return _fetch(routed.url, nextInit);
    } catch (_) {
      return _fetch(input, init);
    }
  };

  var NativeWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    try {
      var routed = apiRequest(url);
      if (routed && api) url = String(routed.url).replace(/^http/i, "ws");
    } catch (_) {}
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  };
  window.WebSocket.prototype = NativeWS.prototype;
  window.WebSocket.OPEN = NativeWS.OPEN; window.WebSocket.CONNECTING = NativeWS.CONNECTING;
  window.WebSocket.CLOSING = NativeWS.CLOSING; window.WebSocket.CLOSED = NativeWS.CLOSED;

  // 1) Refresh token → OS keyring, NEVER the on-disk localStorage (CLIENTS §7.2: "refresh НЕ в
  //    localStorage"). session_storage.ts reads/writes localStorage['gc.session'] synchronously, so we
  //    keep an in-memory mirror seeded from the keyring at boot and shadow just that one key. Every
  //    other key (theme, lang, media speed) passes straight through to the real localStorage.
  var KEY = "gc.session";
  var mem = __GC_SESSION_SEED__; // string (the persisted JSON) or null — embedded by Rust at launch
  var sessionPersistence = Promise.resolve();
  var sessionPersistenceError = null;
  function enqueueSessionPersistence(operation) {
    sessionPersistence = sessionPersistence.then(function () {
      return Promise.resolve().then(operation).then(function () {
        sessionPersistenceError = null;
      }, function (err) {
        sessionPersistenceError = err || new Error("desktop session storage write failed");
      });
    });
  }
  function flushSessionPersistence() {
    var pending = sessionPersistence;
    return pending.then(function () {
      if (pending !== sessionPersistence) return flushSessionPersistence();
      if (sessionPersistenceError !== null) return Promise.reject(sessionPersistenceError);
    });
  }
  window.__gcFlushSessionStorage = flushSessionPersistence;
  try {
    var ls = window.localStorage;
    var _get = ls.getItem.bind(ls), _set = ls.setItem.bind(ls), _rm = ls.removeItem.bind(ls);
    try { _rm(KEY); } catch (e) {} // purge any stale plaintext left by a previous build
    ls.getItem = function (k) { return k === KEY ? mem : _get(k); };
    ls.setItem = function (k, v) {
      if (k !== KEY) return _set(k, v);
      mem = v;
      enqueueSessionPersistence(function () { return invoke("keyring_set", { value: String(v) }); });
    };
    ls.removeItem = function (k) {
      if (k !== KEY) return _rm(k);
      mem = null;
      enqueueSessionPersistence(function () { return invoke("keyring_delete"); });
    };
  } catch (e) { /* storage unavailable — session is non-persistent this launch */ }

  // 2) Unread badge → tray + native notifications, mute-aware for free. The web app calls
  //    navigator.setAppBadge(total) on every badge-affecting event, and the server's /v1/badge total
  //    already EXCLUDES muted + archived chats — so a rise in the total means an unmuted message. We
  //    mirror the count to the tray and, when it rises while the window is unfocused, fire ONE native
  //    notification. A muted chat never moves the total, so it never notifies.
  var lastCount = 0;
  var realSet = typeof navigator.setAppBadge === "function" ? navigator.setAppBadge.bind(navigator) : null;
  var realClear = typeof navigator.clearAppBadge === "function" ? navigator.clearAppBadge.bind(navigator) : null;
  function onBadge(count) {
    var c = Math.max(0, count | 0);
    var chatId = pendingNotificationChatId;
    pendingNotificationChatId = null; // never let an old event target a later notification
    invoke("set_unread", { count: c }).catch(function () {});
    if (c > lastCount && !document.hasFocus() && notificationEnabled) {
      invoke("notify_unread", { count: c, chatId: chatId }).catch(function () {});
    }
    lastCount = c;
  }
  navigator.setAppBadge = function (n) { onBadge(typeof n === "number" ? n : 1); return realSet ? realSet(n) : Promise.resolve(); };
  navigator.clearAppBadge = function () { onBadge(0); return realClear ? realClear() : Promise.resolve(); };

  // 3) Deep links → hash routes. Rust resolves greenchat://… / gcpay://… to the web-equivalent hash
  //    (CLIENTS §deep-links) and emits "gc://navigate"; we apply it to the live SPA and focus.
  if (T.event && typeof T.event.listen === "function") {
    T.event.listen("gc://navigate", function (ev) {
      var hash = ev && ev.payload;
      if (typeof hash === "string" && hash.charAt(0) === "#") location.hash = hash;
    });
  }

  // T-451/T-452) Connector-only OS keyring. Separate service/user names keep Telegram database keys
  // outside GreenChat auth, app-lock and finance key domains. Values are opaque base64 from the core.
  (function installConnectorVaultCapability() {
    var taken = false;
    var vault = {
      claim: function (scope) {
        return invoke("connector_vault_claim", { scope: String(scope) });
      },
      read: function (lease, name) {
        return invoke("connector_vault_read", { lease: String(lease), name: String(name) });
      },
      write: function (lease, name, valueBase64) {
        return invoke("connector_vault_write", {
          lease: String(lease), name: String(name), valueBase64: String(valueBase64),
        });
      },
      remove: function (lease, name) {
        return invoke("connector_vault_remove", { lease: String(lease), name: String(name) });
      },
      wipe: function (lease) {
        return invoke("connector_vault_wipe", { lease: String(lease) });
      },
      release: function (lease) {
        return invoke("connector_vault_release", { lease: String(lease) });
      },
    };
    Object.defineProperty(window, "__gcTakeConnectorSecretVault", {
      configurable: true,
      enumerable: false,
      value: function () {
        if (taken) return null;
        taken = true;
        try { delete window.__gcTakeConnectorSecretVault; } catch (_) {}
        return vault;
      },
    });
  })();

  // T-452) Official TDLib JSON bridge. Rust dynamically loads the packaged tdjson runtime, owns the
  // single receive loop and emits ordered owner-webview events. Numeric TDLib ids, keys and paths stay native.
  // structural bridge on every native platform; a plain browser never gets this global.
  window.__gcTelegramTdlibBridge = {
    platform: "desktop",
    info: function () { return invoke("telegram_info"); },
    create: function (options) { return invoke("telegram_create", { options: options }); },
    send: function (clientId, requestJson) {
      return invoke("telegram_send", { clientId: String(clientId), requestJson: String(requestJson) });
    },
    onMessage: function (clientId, listener) {
      var active = true;
      var unlisten = null;
      if (!T.event || typeof T.event.listen !== "function") return function () {};
      Promise.resolve(T.event.listen("gc://telegram", function (ev) {
        var payload = ev && ev.payload;
        if (!active || !payload || String(payload.clientId) !== String(clientId)) return;
        if (typeof payload.responseJson === "string") listener(payload.responseJson);
      })).then(function (off) {
        if (!active) { try { off(); } catch (e) {} }
        else unlisten = off;
      }).catch(function () {});
      return function () {
        active = false;
        if (unlisten) { try { unlisten(); } catch (e) {} }
      };
    },
    close: function (clientId) { return invoke("telegram_close", { clientId: String(clientId) }); },
    wipe: function (vaultCapability) {
      return invoke("telegram_wipe", {
        vaultCapability: vaultCapability == null ? null : String(vaultCapability),
      });
    },
  };

  // 4) Self-update + force-update (CLIENTS §9). On boot we ask the self-hosted manifest at
  //    GET /v1/client/updates/:platform/:arch?version= for `latest` / `min_supported`. If this build is
  //    below `min_supported`, the app is UNUSABLE until updated — we paint a full-screen blocking
  //    «Обновите приложение» over the SPA (the force-update verdict is computed in Rust from the tested
  //    comparator, never trusted from JS). Otherwise, a newer `latest` surfaces a dismissible banner that
  //    downloads + installs via the updater plugin and relaunches. All of this is best-effort: a manifest
  //    that is missing/unreachable/old-format leaves the app running normally (never a false block).
  function overlay(html) {
    var el = document.createElement("div");
    el.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:2147483647",
      "display:flex", "align-items:center", "justify-content:center",
      "background:#0b141a", "color:#e9edef", "text-align:center",
      "font:16px/1.5 system-ui,sans-serif", "padding:24px",
    ].join(";"));
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  function runUpdate(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Обновление…"; }
    invoke("install_update").catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = "Повторить"; }
      console.warn("[gc] update failed:", e);
    });
    // On success the Rust side relaunches the process, so control never returns here.
  }

  function checkUpdates() {
    if (!ORIGIN) return; // no backend wired → nothing to check against
    invoke("update_target")
      .then(function (target) {
        var current = target[2];
        var url = "/v1/client/updates/" + encodeURIComponent(target[0]) + "/" +
          encodeURIComponent(target[1]) + "?version=" + encodeURIComponent(current);
        return window.fetch(url)
          .then(function (res) { return res.ok ? res.json() : null; })
          .catch(function () { return null; })
          .then(function (manifest) {
            if (!manifest) return;
            var min = manifest.min_supported || manifest.minSupported || null;
            var latest = manifest.latest || manifest.version || null;
            // Ask Rust for the authoritative force-update verdict (never trust the JS comparison).
            return invoke("must_force_update", { current: current, minSupported: min || current })
              .then(function (mustBlock) {
                if (min && mustBlock) {
                  overlay(
                    '<div><h1 style="font-size:22px;margin:0 0 12px">Обновите приложение</h1>' +
                    "<p style=\"opacity:.8;margin:0 0 20px\">Ваша версия " + esc(current) +
                    " больше не поддерживается. Требуется не ниже " + esc(min) + ".</p>" +
                    '<button id="gc-force-btn" style="' + BTN + '">Обновить сейчас</button></div>'
                  );
                  var fb = document.getElementById("gc-force-btn");
                  if (fb) fb.addEventListener("click", function () { runUpdate(fb); });
                  return; // hard stop — no optional banner behind a blocking screen
                }
                if (latest) offerOptional();
              });
          });
      })
      .catch(function (e) { console.warn("[gc] update check skipped:", e); });
  }

  function offerOptional() {
    // The updater plugin's own check() is the source of truth for "is there really a signed artifact";
    // it parks the update in Rust state and returns the offered version (null when none/at-latest).
    invoke("check_update", { minSupported: null })
      .then(function (status) {
        if (!status || !status.availableVersion) return;
        var bar = document.createElement("div");
        bar.setAttribute("style", [
          "position:fixed", "left:50%", "bottom:16px", "transform:translateX(-50%)",
          "z-index:2147483646", "background:#202c33", "color:#e9edef",
          "border-radius:10px", "padding:10px 14px", "display:flex", "gap:12px",
          "align-items:center", "box-shadow:0 6px 24px rgba(0,0,0,.4)",
          "font:14px/1.4 system-ui,sans-serif",
        ].join(";"));
        bar.innerHTML = "<span>Доступна версия " + esc(status.availableVersion) + "</span>";
        var go = document.createElement("button");
        go.setAttribute("style", BTN);
        go.textContent = "Обновить";
        go.addEventListener("click", function () { runUpdate(go); });
        var no = document.createElement("button");
        no.setAttribute("style", "background:none;border:0;color:#8696a0;cursor:pointer;font:inherit");
        no.textContent = "Позже";
        no.addEventListener("click", function () { bar.remove(); });
        bar.appendChild(go);
        bar.appendChild(no);
        document.body.appendChild(bar);
      })
      .catch(function (e) { console.warn("[gc] updater check skipped:", e); });
  }

  var BTN = "background:#00a884;border:0;color:#0b141a;font:600 14px/1 system-ui,sans-serif;border-radius:8px;padding:10px 16px;cursor:pointer";
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // Kick the check once the document is interactive so the overlay has a <body> to attach to.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkUpdates, { once: true });
  } else {
    checkUpdates();
  }
})();
