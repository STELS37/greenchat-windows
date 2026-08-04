export interface VoiceNoteStrings {
  title: string;
  preparing: string;
  ready: string;
  record: string;
  stop: string;
  retake: string;
  send: string;
  recording: string;
  review: string;
  uploading: string;
  uploadingProgress: string;
  sent: string;
  unsupported: string;
  denied: string;
  unavailable: string;
  failed: string;
  uploadFailed: string;
  voiceModeHint: string;
  videoModeHint: string;
}

const RU: VoiceNoteStrings = {
  title: "Голосовое сообщение",
  preparing: "Включаем микрофон…",
  ready: "Удерживайте микрофон в чате или нажмите кнопку записи",
  record: "Начать запись",
  stop: "Остановить запись",
  retake: "Перезаписать",
  send: "Отправить",
  recording: "Запись",
  review: "Прослушайте голосовое сообщение перед отправкой",
  uploading: "Отправляем голосовое сообщение…",
  uploadingProgress: "Отправляем голосовое сообщение: {percent}%",
  sent: "Голосовое сообщение отправлено",
  unsupported: "Запись голосовых сообщений не поддерживается на этом устройстве",
  denied: "Разрешите GreenChat доступ к микрофону",
  unavailable: "Микрофон сейчас недоступен",
  failed: "Не удалось записать голосовое сообщение",
  uploadFailed: "Не удалось отправить голосовое сообщение. Проверьте интернет и повторите",
  voiceModeHint: "Голосовое сообщение. Нажмите, чтобы выбрать видеокружок; удерживайте для записи",
  videoModeHint: "Видеокружок. Нажмите, чтобы выбрать голосовое сообщение; удерживайте для записи",
};

const EN: VoiceNoteStrings = {
  title: "Voice message",
  preparing: "Starting the microphone…",
  ready: "Hold the microphone in chat or press the record button",
  record: "Start recording",
  stop: "Stop recording",
  retake: "Record again",
  send: "Send",
  recording: "Recording",
  review: "Review the voice message before sending",
  uploading: "Sending voice message…",
  uploadingProgress: "Sending voice message: {percent}%",
  sent: "Voice message sent",
  unsupported: "Voice-message recording is not supported on this device",
  denied: "Allow GreenChat to use the microphone",
  unavailable: "The microphone is currently unavailable",
  failed: "Could not record the voice message",
  uploadFailed: "Could not send the voice message. Check your connection and try again",
  voiceModeHint: "Voice message. Tap for a video note; hold to record",
  videoModeHint: "Video note. Tap for a voice message; hold to record",
};

export function voiceNoteStrings(locale: string): VoiceNoteStrings {
  return locale.toLowerCase().startsWith("ru") ? RU : EN;
}

export function voiceNoteFormat(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{${key}}`, String(value));
  return out;
}
