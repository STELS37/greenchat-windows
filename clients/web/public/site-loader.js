/* Green Chat root-mode switch.
   - Ordinary first-time browser navigation renders the public site without downloading the app bundle.
   - Existing sessions, explicit ?app=1 links, PWA standalone mode, hash routes and native protocols boot
     the shared application exactly as before.
   - ?site=1 is an explicit marketing-page override used by support and deterministic browser tests. */
(function () {
  "use strict";

  var root = document.documentElement;
  var script = document.currentScript;
  var query;
  try { query = new URLSearchParams(location.search); } catch (_err) { query = new URLSearchParams(); }

  var forceSite = query.get("site") === "1" || (script && script.getAttribute("data-site-only") === "1");
  var forceApp = query.get("app") === "1";
  var appProtocol = location.protocol !== "http:" && location.protocol !== "https:";
  var appHash = location.hash === "#" || location.hash.indexOf("#/") === 0;
  var standalone = false;
  var hasSession = false;
  var automated = false;

  try {
    standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  } catch (_err) { standalone = false; }
  try { hasSession = !!localStorage.getItem("gc.session"); } catch (_err) { hasSession = false; }
  try { automated = navigator.webdriver === true; } catch (_err) { automated = false; }

  var appMode = !forceSite && (forceApp || appProtocol || appHash || standalone || hasSession || automated);
  root.setAttribute("data-gc-mode", appMode ? "app" : "site");

  if (appMode) {
    var styleMarker = document.querySelector('meta[name="gc-app-style"]');
    if (styleMarker) {
      var styleHref = styleMarker.getAttribute("content");
      if (styleHref) {
        var appStyle = document.createElement("link");
        appStyle.id = "gc-app-style";
        appStyle.rel = "stylesheet";
        appStyle.href = styleHref;
        styleMarker.replaceWith(appStyle);
      }
    }
    var entry = script && script.getAttribute("data-app-entry");
    if (entry) {
      import(entry).catch(function () {
        function showFailure() {
          var host = document.getElementById("app");
          if (!host) return;
          host.removeAttribute("aria-busy");
          host.textContent = "Не удалось загрузить Green Chat. Проверьте соединение и обновите страницу.";
        }
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showFailure, { once: true });
        else showFailure();
      });
    }
    return;
  }

  function formatMb(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) return "";
    var english = String(root.lang || "").toLowerCase().indexOf("en") === 0;
    var locale = english ? "en-US" : "ru-RU";
    return (bytes / 1000000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (english ? " MB" : " МБ");
  }

  function platformName() {
    var ua = "";
    var platform = "";
    try {
      ua = navigator.userAgent || "";
      platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    } catch (_err) { /* best effort */ }
    var value = (ua + " " + platform).toLowerCase();
    if (/android/.test(value)) return "android";
    if (/iphone|ipad|ipod/.test(value) || (/mac/.test(value) && navigator.maxTouchPoints > 1)) return "ios";
    if (/win/.test(value)) return "windows";
    if (/mac/.test(value)) return "macos";
    if (/linux|x11/.test(value)) return "linux";
    return "web";
  }

  function setText(selector, value) {
    if (value === undefined || value === null || value === "") return;
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i += 1) nodes[i].textContent = String(value);
  }

  function applyDownloads(data) {
    if (!data || typeof data !== "object" || !data.platforms) return;
    var current = typeof data.current_version === "string" ? data.current_version : "";
    setText("[data-current-version]", current);

    Object.keys(data.platforms).forEach(function (name) {
      var item = data.platforms[name];
      if (!item || typeof item !== "object") return;
      setText('[data-version="' + name + '"]', item.version);
      var links = document.querySelectorAll('[data-download="' + name + '"]');
      for (var i = 0; i < links.length; i += 1) {
        if (typeof item.url === "string" && item.url) links[i].setAttribute("href", item.url);
      }
      if (name === "android") {
        setText('[data-size="android"]', formatMb(item.size_bytes));
        setText('[data-sha256="android"]', item.sha256);
      }
      if (name === "windows" && item.status === "available") {
        setText('[data-size="windows"]', formatMb(item.size_bytes));
        setText('[data-sha256="windows"]', item.sha256);
      }
      if (name === "linux" && item.packages) {
        Object.keys(item.packages).forEach(function (kind) {
          var pkg = item.packages[kind];
          if (!pkg || typeof pkg !== "object") return;
          var packageLinks = document.querySelectorAll('[data-download="linux-' + kind + '"]');
          for (var k = 0; k < packageLinks.length; k += 1) {
            if (typeof pkg.url === "string" && pkg.url) packageLinks[k].setAttribute("href", pkg.url);
          }
          setText('[data-size="linux-' + kind + '"]', formatMb(pkg.size_bytes));
          setText('[data-sha256="linux-' + kind + '"]', pkg.sha256);
        });
      }
    });

    var recommended = platformName();
    var chosen = data.platforms[recommended] || data.platforms.web;
    var primary = document.querySelector("[data-primary-download]");
    var note = document.querySelector("[data-primary-note]");
    var english = String(root.lang || "").toLowerCase().indexOf("en") === 0;
    var windowsNative = recommended === "windows" && chosen && chosen.status === "available";
    var labels = english ? {
      android: "Download for Android",
      ios: "Open on iPhone / iPad",
      windows: windowsNative ? "Download for Windows" : "Open for Windows",
      macos: "Open for macOS",
      linux: "Download AppImage",
      web: "Open web app"
    } : {
      android: "Скачать для Android",
      ios: "Открыть на iPhone / iPad",
      windows: windowsNative ? "Скачать для Windows" : "Открыть для Windows",
      macos: "Открыть для macOS",
      linux: "Скачать AppImage",
      web: "Открыть веб-версию"
    };
    var androidMinOs = (data.platforms.android && data.platforms.android.min_os) || "Android";
    var windowsItem = data.platforms.windows || {};
    var windowsNote = windowsItem.status === "available"
      ? (english
        ? "Native x86_64 beta · " + formatMb(windowsItem.size_bytes) + (windowsItem.signed === true ? " · publisher-signed." : " · Windows may warn about an Unknown publisher.")
        : "Нативная beta x86_64 · " + formatMb(windowsItem.size_bytes) + (windowsItem.signed === true ? " · подписана издателем." : " · Windows может предупредить о неизвестном издателе."))
      : (english
        ? "The web/PWA version is available now; a native installer is in preparation."
        : "Веб/PWA-версия доступна сейчас; нативный установщик готовится.");
    var notes = english ? {
      android: "Signed APK · " + formatMb(data.platforms.android && data.platforms.android.size_bytes) + " · " + androidMinOs + "+",
      ios: "Available as a web app and Home Screen PWA.",
      windows: windowsNote,
      macos: "The web/PWA version is available now; a signed DMG is in preparation.",
      linux: "Native x86_64 packages: AppImage and DEB. The web app is also available.",
      web: "Runs directly in your browser. Installation is optional."
    } : {
      android: "Подписанный APK · " + formatMb(data.platforms.android && data.platforms.android.size_bytes) + " · " + androidMinOs + "+",
      ios: "Доступно как веб-приложение и PWA для главного экрана.",
      windows: windowsNote,
      macos: "Веб/PWA-версия доступна сейчас; подписанный DMG готовится.",
      linux: "Нативные пакеты x86_64: AppImage и DEB. Веб-версия также доступна.",
      web: "Работает прямо в браузере. Установка не обязательна."
    };
    if (primary && chosen && typeof chosen.url === "string") {
      primary.setAttribute("href", chosen.url);
      primary.textContent = labels[recommended] || labels.web;
      if (chosen.status === "available" && typeof chosen.artifact_filename === "string") primary.setAttribute("download", "");
      else primary.removeAttribute("download");
    }
    if (note) note.textContent = notes[recommended] || notes.web;

    var cards = document.querySelectorAll("[data-platform-card]");
    for (var j = 0; j < cards.length; j += 1) cards[j].classList.remove("platform-recommended");
    var card = document.querySelector('[data-platform-card="' + recommended + '"]');
    if (card) card.classList.add("platform-recommended");
  }

  function enhanceSite() {
    var downloadsUrl = (script && script.getAttribute("data-downloads-url")) || "/downloads.json";
    fetch(downloadsUrl, { method: "GET", cache: "no-cache", credentials: "same-origin" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(applyDownloads)
      .catch(function () { /* Static fallback copy remains fully usable. */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhanceSite, { once: true });
  else enhanceSite();
}());
