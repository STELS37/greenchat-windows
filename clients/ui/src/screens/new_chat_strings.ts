// Local copy for the creation hub. The base locale dictionaries are deliberately not involved: this
// surface can ship independently while other agents edit the shared dictionaries, and every string is
// still selected from the same app locale (ru/en) rather than leaking English into a Russian client.
export type NewChatStringKey =
  | "hubTitle"
  | "hubLead"
  | "direct"
  | "directHint"
  | "group"
  | "groupHint"
  | "broadcast"
  | "broadcastHint"
  | "channel"
  | "channelHint"
  | "bot"
  | "botHint"
  | "people"
  | "groupTitle"
  | "broadcastTitle"
  | "channelTitle"
  | "name"
  | "groupNamePlaceholder"
  | "broadcastNamePlaceholder"
  | "channelNamePlaceholder"
  | "description"
  | "descriptionOptional"
  | "participants"
  | "participantsHint"
  | "searchParticipants"
  | "searchParticipantsHint"
  | "selectedCount"
  | "public"
  | "private"
  | "publicHint"
  | "privateHint"
  | "username"
  | "usernamePlaceholder"
  | "usernameHint"
  | "createGroup"
  | "createBroadcast"
  | "createChannel"
  | "creating"
  | "nameRequired"
  | "usernameRequired"
  | "unavailable"
  | "openCreated";

type Dictionary = Record<NewChatStringKey, string>;

const RU: Dictionary = {
  hubTitle: "Создать",
  hubLead: "Выберите, что хотите начать",
  direct: "Личное сообщение",
  directHint: "Найдите человека и сразу откройте диалог",
  group: "Группа",
  groupHint: "Общий чат для команды, друзей или проекта",
  broadcast: "Рассылка",
  broadcastHint: "Публикуете вы — подписчики получают обновления",
  channel: "Канал",
  channelHint: "Публичная или приватная лента публикаций",
  bot: "Бот",
  botHint: "Автоматизация, команды, сервисы и Mini Apps",
  people: "Люди",
  groupTitle: "Новая группа",
  broadcastTitle: "Новая рассылка",
  channelTitle: "Новый канал",
  name: "Название",
  groupNamePlaceholder: "Например, Команда проекта",
  broadcastNamePlaceholder: "Например, Новости компании",
  channelNamePlaceholder: "Например, GreenChat Новости",
  description: "Описание",
  descriptionOptional: "Кратко объясните назначение — необязательно",
  participants: "Участники",
  participantsHint: "Ваши контакты показаны сразу; остальных можно найти через поиск",
  searchParticipants: "Поиск по контактам или по @имени",
  searchParticipantsHint: "Для поиска вне контактов введите минимум 2 символа",
  selectedCount: "Выбрано: {count}",
  public: "Публичный",
  private: "Приватный",
  publicHint: "Канал находится через поиск и открывается по @имени",
  privateHint: "Доступ только по заявке: администратор принимает или отклоняет запрос",
  username: "Публичное @имя",
  usernamePlaceholder: "greenchat_news",
  usernameHint: "Латинские буквы, цифры и подчёркивание",
  createGroup: "Создать группу",
  createBroadcast: "Создать рассылку",
  createChannel: "Создать канал",
  creating: "Создаём…",
  nameRequired: "Введите название",
  usernameRequired: "Для публичного канала укажите @имя",
  unavailable: "Эта возможность временно недоступна",
  openCreated: "Открыть созданный чат",
};

const EN: Dictionary = {
  hubTitle: "Create",
  hubLead: "Choose what you want to start",
  direct: "Direct message",
  directHint: "Find someone and open a private conversation",
  group: "Group",
  groupHint: "A shared chat for a team, friends, or a project",
  broadcast: "Broadcast",
  broadcastHint: "You publish; subscribers receive every update",
  channel: "Channel",
  channelHint: "A public or private publication feed",
  bot: "Bot",
  botHint: "Automation, commands, services, and Mini Apps",
  people: "People",
  groupTitle: "New group",
  broadcastTitle: "New broadcast",
  channelTitle: "New channel",
  name: "Name",
  groupNamePlaceholder: "For example, Project team",
  broadcastNamePlaceholder: "For example, Company updates",
  channelNamePlaceholder: "For example, GreenChat News",
  description: "Description",
  descriptionOptional: "Explain its purpose briefly — optional",
  participants: "Participants",
  participantsHint: "Your contacts appear immediately; search to find anyone else",
  searchParticipants: "Search contacts or find by @username",
  searchParticipantsHint: "Type at least 2 characters to search beyond contacts",
  selectedCount: "Selected: {count}",
  public: "Public",
  private: "Private",
  publicHint: "People can find it in search and open it by @username",
  privateHint: "Access is request-only: an admin approves or declines each request",
  username: "Public @username",
  usernamePlaceholder: "greenchat_news",
  usernameHint: "Latin letters, numbers, and underscores",
  createGroup: "Create group",
  createBroadcast: "Create broadcast",
  createChannel: "Create channel",
  creating: "Creating…",
  nameRequired: "Enter a name",
  usernameRequired: "Enter an @username for a public channel",
  unavailable: "This option is temporarily unavailable",
  openCreated: "Open created chat",
};

export function newChatText(
  locale: string,
  key: NewChatStringKey,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const source = locale.toLowerCase().startsWith("ru") ? RU : EN;
  return source[key].replace(/\{([a-z]+)\}/gi, (_match, name: string) => String(vars[name] ?? ""));
}
