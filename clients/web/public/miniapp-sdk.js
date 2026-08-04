/* GreenChat Mini Apps SDK v1 — dependency-free, native GreenChat protocol. */
(function miniAppSdk(global) {
  "use strict";

  // The official SDK must be loaded directly from the GreenChat host. Its script origin becomes the
  // only parent origin allowed to initialize the bridge, so an arbitrary embedding page cannot forge
  // a convincing-looking init event. Backend code must still verify initData cryptographically.
  var scriptElement = global.document && global.document.currentScript;
  var sdkOrigin = null;
  try {
    sdkOrigin = scriptElement && scriptElement.src ? new URL(scriptElement.src).origin : null;
  } catch (_) {
    sdkOrigin = null;
  }

  var hostOrigin = null;
  var hostWindow = null;
  var sequence = 0;
  var pending = new Map();
  var listeners = new Map();
  var controlEvents = new Set([
    "mainButtonPressed",
    "backButtonPressed",
    "settingsButtonPressed",
    "invoicePaid",
    "invoiceClosed"
  ]);
  var mainButtonState = { visible: false, text: "", enabled: true, loading: false };
  var backButtonVisible = false;
  var settingsButtonVisible = false;

  function emit(name, payload) {
    var set = listeners.get(name);
    if (!set) return;
    Array.from(set).forEach(function notify(fn) {
      try { fn(payload); } catch (_) { /* an app listener cannot break the bridge */ }
    });
  }

  function onEvent(name, handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    var set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(handler);
    return function unsubscribe() { set.delete(handler); };
  }

  function nextId() {
    sequence += 1;
    return "gcma-" + Date.now().toString(36) + "-" + sequence.toString(36);
  }

  function request(method, payload) {
    if (!hostOrigin || !hostWindow) return Promise.reject(new Error("GreenChat Mini App is not initialized"));
    var id = nextId();
    return new Promise(function executor(resolve, reject) {
      var timer = global.setTimeout(function timedOut() {
        pending.delete(id);
        reject(new Error("GreenChat Mini App request timed out"));
      }, 10000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      hostWindow.postMessage({
        type: "greenchat:miniapp",
        version: 1,
        id: id,
        method: method,
        payload: payload
      }, hostOrigin);
    });
  }

  function mainButtonPayload() {
    return {
      visible: mainButtonState.visible,
      text: mainButtonState.text,
      enabled: mainButtonState.enabled,
      loading: mainButtonState.loading
    };
  }

  function syncMainButton() {
    return request("setMainButton", mainButtonPayload());
  }

  function cleanButtonText(text) {
    if (typeof text !== "string") throw new TypeError("button text must be a string");
    var cleaned = text.trim();
    if (!cleaned || Array.from(cleaned).length > 64 || /[\u0000-\u001f\u007f]/.test(cleaned))
      throw new TypeError("button text must be 1..64 visible characters");
    return cleaned;
  }

  var MainButton = {
    setText: function setText(text) {
      mainButtonState.text = cleanButtonText(text);
      return syncMainButton();
    },
    show: function show() {
      if (!mainButtonState.text) return Promise.reject(new Error("set MainButton text before show"));
      mainButtonState.visible = true;
      return syncMainButton();
    },
    hide: function hide() {
      mainButtonState.visible = false;
      return syncMainButton();
    },
    enable: function enable() {
      mainButtonState.enabled = true;
      return syncMainButton();
    },
    disable: function disable() {
      mainButtonState.enabled = false;
      return syncMainButton();
    },
    showProgress: function showProgress() {
      mainButtonState.loading = true;
      return syncMainButton();
    },
    hideProgress: function hideProgress() {
      mainButtonState.loading = false;
      return syncMainButton();
    },
    onClick: function onClick(handler) { return onEvent("mainButtonPressed", handler); }
  };

  var BackButton = {
    show: function show() {
      backButtonVisible = true;
      return request("setBackButton", { visible: true });
    },
    hide: function hide() {
      backButtonVisible = false;
      return request("setBackButton", { visible: false });
    },
    isVisible: function isVisible() { return backButtonVisible; },
    onClick: function onClick(handler) { return onEvent("backButtonPressed", handler); }
  };

  var SettingsButton = {
    show: function show() {
      settingsButtonVisible = true;
      return request("setSettingsButton", { visible: true });
    },
    hide: function hide() {
      settingsButtonVisible = false;
      return request("setSettingsButton", { visible: false });
    },
    isVisible: function isVisible() { return settingsButtonVisible; },
    onClick: function onClick(handler) { return onEvent("settingsButtonPressed", handler); }
  };

  var MiniApp = {
    version: "1.0",
    initData: "",
    initDataUnsafe: null,
    themeParams: {},
    bridge: null,
    isReady: false,
    onEvent: onEvent,
    MainButton: MainButton,
    BackButton: BackButton,
    SettingsButton: SettingsButton,
    ready: function ready() { return request("ready"); },
    close: function close() { return request("close"); },
    expand: function expand() { return request("expand"); },
    requestTheme: function requestTheme() { return request("requestTheme"); },
    writeClipboard: function writeClipboard(text) {
      if (typeof text !== "string" || text.length === 0 || text.length > 4096)
        return Promise.reject(new TypeError("clipboard text must be 1..4096 characters"));
      return request("writeClipboard", { text: text });
    },
    openLink: function openLink(url) {
      if (typeof url !== "string" || !url.startsWith("https://"))
        return Promise.reject(new TypeError("only HTTPS links are allowed"));
      return request("openLink", { url: url });
    },
    openInvoice: function openInvoice(code) {
      if (typeof code !== "string" || !/^[0-9a-f]{32}$/i.test(code.trim()))
        return Promise.reject(new TypeError("invoice code must be 32 hexadecimal characters"));
      return request("openInvoice", { code: code.trim().toLowerCase() });
    },
    onInvoicePaid: function onInvoicePaid(handler) { return onEvent("invoicePaid", handler); },
    onInvoiceClosed: function onInvoiceClosed(handler) { return onEvent("invoiceClosed", handler); }
  };

  function cleanInvoiceEvent(name, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    var keys = Object.keys(payload).sort();
    if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "status") return null;
    if (typeof payload.code !== "string" || !/^[0-9a-f]{32}$/.test(payload.code)) return null;
    var status = name === "invoicePaid" ? "paid" : "cancelled";
    if (payload.status !== status) return null;
    return { code: payload.code, status: status };
  }

  global.addEventListener("message", function onMessage(event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "greenchat:init" && data.version === 1) {
      if (!sdkOrigin || event.source !== global.parent || event.origin !== sdkOrigin) return;
      hostOrigin = event.origin;
      hostWindow = event.source;
      MiniApp.initData = typeof data.initData === "string" ? data.initData : "";
      MiniApp.initDataUnsafe = data.initDataUnsafe || null;
      MiniApp.themeParams = data.themeParams && typeof data.themeParams === "object" ? data.themeParams : {};
      MiniApp.bridge = data.bridge || null;
      MiniApp.isReady = true;
      emit("init", {
        initData: MiniApp.initData,
        initDataUnsafe: MiniApp.initDataUnsafe,
        themeParams: MiniApp.themeParams,
        bridge: MiniApp.bridge
      });
      void MiniApp.ready().catch(function ignore() {});
      return;
    }

    if (data.type === "greenchat:event" && data.version === 1) {
      if (!hostOrigin || event.origin !== hostOrigin || event.source !== hostWindow) return;
      if (typeof data.event !== "string" || !controlEvents.has(data.event)) return;
      if (data.event === "invoicePaid" || data.event === "invoiceClosed") {
        var invoiceEvent = cleanInvoiceEvent(data.event, data.payload);
        if (!invoiceEvent) return;
        emit(data.event, invoiceEvent);
        return;
      }
      emit(data.event, data.payload);
      return;
    }

    if (data.type === "greenchat:host-response" && data.version === 1) {
      if (!hostOrigin || event.origin !== hostOrigin || event.source !== hostWindow) return;
      var slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      global.clearTimeout(slot.timer);
      if (data.ok === true) slot.resolve(data.result);
      else slot.reject(new Error(typeof data.error === "string" ? data.error : "GreenChat Mini App request failed"));
    }
  });

  var namespace = global.GreenChat && typeof global.GreenChat === "object" ? global.GreenChat : {};
  namespace.MiniApp = MiniApp;
  global.GreenChat = namespace;
})(window);
