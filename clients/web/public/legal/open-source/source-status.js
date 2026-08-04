const status = document.querySelector("#source-status");
const link = document.querySelector("#source-link");

if (status instanceof HTMLElement && link instanceof HTMLAnchorElement) {
  try {
    const response = await fetch("/downloads.json", { cache: "no-store" });
    if (!response.ok) throw new Error("catalog unavailable");
    const catalog = await response.json();
    const android = catalog?.platforms?.android;
    const supplemental = Array.isArray(catalog?.supplemental_artifacts)
      ? catalog.supplemental_artifacts
      : [];
    const source = supplemental.find((row) =>
      row?.kind === "corresponding_source"
      && row?.for_artifact === android?.artifact_filename
    );
    if (source && typeof source.url === "string" && source.url.startsWith("/")) {
      link.href = source.url;
      link.hidden = false;
      status.textContent = `Исходный код для версии ${catalog.current_version}: ${source.artifact_filename} (SHA-256: ${source.sha256}).`;
    } else if (android?.contains_gpl_engine === true) {
      status.textContent = "Каталог релиза не содержит обязательную ссылку на Corresponding Source. Не устанавливайте этот APK и сообщите в поддержку.";
    } else {
      status.textContent = "Текущий опубликованный Android APK не объявляет встроенный GPL engine. Для релиза с engine ссылка появится здесь автоматически.";
    }
  } catch {
    status.textContent = "Каталог релиза временно недоступен. Повторите попытку позже.";
  }
}
