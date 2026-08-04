// Feature-local copy for the Contacts acquisition surface.
// Keeping this fragment beside the screen lets parallel product areas evolve their own wording without
// forcing every change through the two monolithic locale dictionaries. Existing shared contact/common
// keys still fall back to the application's I18n instance.
import type { I18n, Params } from "../i18n.ts";

const COPY: Record<"ru" | "en", Record<string, string>> = {
  ru: {
    "contacts.subtitle": "Люди, приглашения и быстрый поиск",
    // 320px keeps 228px of text room in the search pill; the previous wording measured 322.4px and was
    // cut mid-letter, hiding the «@имя» affordance entirely. This one measures 210.4px — it fits whole
    // on the narrowest supported phone and still names both ways to search. See contacts.css.
    "contacts.searchPlaceholder": "Найти человека или @имя",
    "contacts.empty": "Здесь пока никого нет",
    "contacts.emptyLead": "Синхронизируйте телефонную книгу или найдите человека по имени.",
    "contacts.emptyAction": "Перейти к поиску",
    "contacts.growthKicker": "Быстрый старт",
    "contacts.growthTitle": "Найдите своих людей",
    "contacts.growthLead": "Добавьте тех, кто уже в GreenChat, и пригласите остальных одной ссылкой.",
    "contacts.syncAction": "Синхронизировать контакты",
    "contacts.syncActionLead": "Найти знакомых из телефонной книги",
    "contacts.inviteAction": "Пригласить друзей",
    "contacts.inviteActionLead": "Выбрать получателя и открыть SMS",
    "contacts.copyAction": "Скопировать ссылку",
    "contacts.copyActionLead": "Отправить её в любом приложении",
    "contacts.privacyNote": "Имена и номера не отправляются. На сервер уходят только временные SHA-256-хэши номеров.",
    "contacts.syncReading": "Читаем телефонную книгу на устройстве…",
    "contacts.syncChecking": "Проверяем {count} номеров без передачи самих номеров…",
    "contacts.syncNoNumbers": "Подходящих номеров для синхронизации не найдено.",
    "contacts.syncAdded": "Готово: проверено {checked}, добавлено {added}.",
    "contacts.syncAlready": "Готово: проверено {checked}. Все найденные уже в контактах.",
    "contacts.syncNobody": "Проверено {checked}. Новых пользователей GreenChat не найдено.",
    "contacts.syncSkipped": "Не удалось безопасно распознать номеров: {count}.",
    "contacts.syncTruncated": "За один запуск проверены первые 1500 номеров.",
    "contacts.syncPermissionDenied": "Доступ к контактам не предоставлен. Его можно разрешить в настройках телефона.",
    "contacts.syncUnsupported": "На этом устройстве синхронизация телефонной книги недоступна. Поиск и приглашения работают без неё.",
    "contacts.syncRateLimited": "Синхронизация уже выполнялась недавно. Повторите через {minutes} мин.",
    "contacts.syncFailed": "Не удалось синхронизировать контакты. Повторите попытку позже.",
    "contacts.inviteText": "Присоединяйся ко мне в GreenChat: {url}",
    "contacts.inviteShareTitle": "Приглашение в GreenChat",
    "contacts.inviteOpened": "Получатель выбран — осталось подтвердить отправку SMS.",
    "contacts.inviteShared": "Окно отправки приглашения открыто.",
    "contacts.inviteFailed": "Не удалось открыть отправку приглашения.",
    "contacts.linkCopied": "Ссылка приглашения скопирована.",
    "contacts.copyFailed": "Не удалось скопировать ссылку. Используйте кнопку приглашения.",
  },
  en: {
    "contacts.subtitle": "People, invitations and quick search",
    // 236.9px at 320px viewport for the previous wording vs 228px of room; this one measures 201.2px.
    "contacts.searchPlaceholder": "Find people or @username",
    "contacts.empty": "No one here yet",
    "contacts.emptyLead": "Sync your phonebook or find someone by name.",
    "contacts.emptyAction": "Go to search",
    "contacts.growthKicker": "Quick start",
    "contacts.growthTitle": "Find your people",
    "contacts.growthLead": "Add people already on GreenChat and invite everyone else with one link.",
    "contacts.syncAction": "Sync contacts",
    "contacts.syncActionLead": "Find people from your phonebook",
    "contacts.inviteAction": "Invite friends",
    "contacts.inviteActionLead": "Choose a recipient and open SMS",
    "contacts.copyAction": "Copy invite link",
    "contacts.copyActionLead": "Send it in any app",
    "contacts.privacyNote": "Names and phone numbers are not uploaded. The server receives only temporary SHA-256 phone hashes.",
    "contacts.syncReading": "Reading the phonebook on this device…",
    "contacts.syncChecking": "Checking {count} numbers without uploading the numbers…",
    "contacts.syncNoNumbers": "No suitable phone numbers were found to sync.",
    "contacts.syncAdded": "Done: checked {checked}, added {added}.",
    "contacts.syncAlready": "Done: checked {checked}. Everyone found is already in your contacts.",
    "contacts.syncNobody": "Checked {checked}. No new GreenChat users were found.",
    "contacts.syncSkipped": "Could not safely recognise {count} numbers.",
    "contacts.syncTruncated": "The first 1,500 numbers were checked in this run.",
    "contacts.syncPermissionDenied": "Contact access was not granted. You can enable it in the phone settings.",
    "contacts.syncUnsupported": "Phonebook sync is unavailable on this device. Search and invitations still work.",
    "contacts.syncRateLimited": "Contacts were synced recently. Try again in {minutes} min.",
    "contacts.syncFailed": "Contacts could not be synced. Please try again later.",
    "contacts.inviteText": "Join me on GreenChat: {url}",
    "contacts.inviteShareTitle": "GreenChat invitation",
    "contacts.inviteOpened": "Recipient selected — confirm the SMS to send it.",
    "contacts.inviteShared": "The invitation share sheet is open.",
    "contacts.inviteFailed": "The invitation could not be opened.",
    "contacts.linkCopied": "Invite link copied.",
    "contacts.copyFailed": "The link could not be copied. Use the invite button instead.",
  },
};

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined ? whole : String(value);
  });
}

export function createContactsCopy(i18n: I18n): (key: string, params?: Params) => string {
  return (key, params) => {
    const template = COPY[i18n.locale][key];
    return template === undefined ? i18n.t(key, params) : interpolate(template, params);
  };
}
