import type { Locale } from "../i18n.ts";

const RU = {
  open: "Настройки звонка",
  title: "Настройки звонка",
  close: "Закрыть настройки звонка",
  sound: "Звук",
  video: "Видео",
  output: "Вывод звука",
  microphone: "Микрофон",
  camera: "Камера",
  systemDevice: "Системное устройство",
  unknownOutput: "Динамики {index}",
  unknownMicrophone: "Микрофон {index}",
  unknownCamera: "Камера {index}",
  loading: "Ищем устройства…",
  applying: "Переключаем устройство…",
  unavailable: "Устройства не найдены",
  outputUnsupported: "Выбор динамиков недоступен на этом устройстве",
  labelsHidden: "Названия появятся после предоставления доступа к микрофону или камере.",
  refreshFailed: "Не удалось получить список устройств.",
  switchFailed: "Не удалось переключить устройство. Оно могло быть отключено.",
} as const;

type Dictionary = { [K in keyof typeof RU]: string };

const EN: Dictionary = {
  open: "Call settings",
  title: "Call settings",
  close: "Close call settings",
  sound: "Sound",
  video: "Video",
  output: "Audio output",
  microphone: "Microphone",
  camera: "Camera",
  systemDevice: "System device",
  unknownOutput: "Speaker {index}",
  unknownMicrophone: "Microphone {index}",
  unknownCamera: "Camera {index}",
  loading: "Finding devices…",
  applying: "Switching device…",
  unavailable: "No devices found",
  outputUnsupported: "Speaker selection is unavailable on this device",
  labelsHidden: "Device names appear after microphone or camera access is granted.",
  refreshFailed: "The device list could not be loaded.",
  switchFailed: "The device could not be switched. It may have been disconnected.",
};

export type CallDeviceTextKey = keyof typeof RU;

export function callDeviceText(locale: Locale, key: CallDeviceTextKey, vars: Record<string, string> = {}): string {
  let value: string = (locale === "ru" ? RU : EN)[key];
  for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, replacement);
  return value;
}
