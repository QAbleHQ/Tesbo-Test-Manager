/*
 * Russian text for everything Zyra's backend writes into a chat itself — the fixed replies, notes,
 * banners and plan messages — used when a session's language is "ru" (zyra_chat_sessions.language,
 * set from the script of what the user typed; see common/script-language.ts).
 *
 * English is deliberately NOT here. Every call site keeps its original English expression and picks
 * this catalog only in an explicit `language === "ru"` branch, so no English reply can change by a
 * single character — several English strings are matched elsewhere (the "Sorry! Nothing was saved"
 * banner by insertZyraAssistantMessage's outcome label, the disclosure phrases by
 * ZYRA_ALREADY_DISCLOSED, "continue" by isZyraResumeIntent) and the backend unit specs pin them.
 *
 * Kept English inside Russian text, on purpose: the draft suite's name (it is a real suite row —
 * translating it would look up or create a different one), suite and test case names, and raw
 * provider error text interpolated as a reason. Each of those is data, not wording.
 *
 * The patterns at the bottom are the Russian counterparts of the English ones in LegacyService.
 * JavaScript's \b only knows ASCII word characters, so they bound words with Unicode lookarounds.
 */

const n = (count: number) => String(count);

export const ZYRA_RU = {
  // generateZyraChatTestcasesWithAi
  draftedAfterReading: (count: number, sources: string[]) =>
    `Я подготовил(а) ${n(count)} тест-кейс(ов), изучив: ${sources.join(", ")}.`,
  sourceKnowledge: (count: number, fromJira: number) =>
    `материалы базы знаний: ${n(count)}${fromJira ? ` (из них из Jira: ${n(fromJira)})` : ""}`,
  sourceJira: (count: number) => `тикеты Jira, прочитанные напрямую: ${n(count)}`,
  sourceExisting: (count: number) => `существующие тест-кейсы (чтобы не дублировать покрытие): ${n(count)}`,
  sourceBugs: (count: number) => `связанные баги: ${n(count)}`,
  generationReasoning: (provider: string, model: string, jiraKeys: string[], input: number, output: number) =>
    `Генерация через ${provider}/${model}. Учтены ключи Jira: ${jiraKeys.length ? jiraKeys.join(", ") : "явно не указаны"}, контекст базы знаний, существующее покрытие (чтобы избежать дублей) и память Zyra. Токены: вход ${n(input)}, выход ${n(output)}.`,

  draftFilingHintDraftSuite: (draftSuite: string) =>
    `Они сохранены как черновики в **${draftSuite}** — напишите «сохрани их в <набор>», и я перенесу их куда нужно.`,
  draftFilingHintSuite: (suiteName: string | null) =>
    `Это черновики в наборе **${suiteName}** — проверьте их там или напишите «сохрани их в <набор>», чтобы перенести.`,
  ungroundedNote: (count: number) =>
    [
      "ℹ️ В базе знаний проекта нет ничего об этом, и ни один тикет Jira тоже не подошёл.",
      "",
      `Я всё равно написал(а) ${n(count)} тест-кейс(ов) на основе общей практики для подобной функции, чтобы было с чего начать — считайте их черновиком для проверки, а не покрытием реального поведения.`,
      "",
      "Добавьте требование, спецификацию или критерии приёмки в базу знаний (или привяжите тикет Jira) и спросите снова — я перегенерирую их с учётом того, как ваша функция работает на самом деле, с вашей терминологией и граничными случаями."
    ].join("\n"),
  knowledgeBaseOffNote: (count: number) =>
    [
      "ℹ️ У меня нет доступа к базе знаний — доступ к базе знаний для Zyra в этом проекте выключен.",
      "",
      `Я подготовил(а) ${n(count)} тест-кейс(ов) в общем виде, на основе типичной практики для подобной функции — считайте их черновиком для проверки, а не покрытием реального поведения.`,
      "",
      "Чтобы опираться на ваши собственные требования, включите доступ к базе знаний в настройках Zyra и спросите снова."
    ].join("\n"),
  weakGroundingNote: (count: number) =>
    [
      "⚠️ То, что я нашёл(ла) в базе знаний проекта, лишь отдалённо соответствует запросу — этого недостаточно, чтобы считать это реальным покрытием.",
      "",
      `Я всё равно написал(а) ${n(count)} тест-кейс(ов) на основе найденного и общей практики для подобной функции — считайте их черновиком для проверки, а не подтверждённым покрытием реального поведения.`,
      "",
      "Если для этой функции есть более точное требование, спецификация или тикет Jira, добавьте его в базу знаний (или привяжите тикет) и спросите снова — я перегенерирую их с учётом реального поведения."
    ].join("\n"),

  // startZyraChatPlan
  planFirstIntroRequeued: (drafted: number, firstBatch: number, requeued: number) =>
    `Вот ${n(drafted)} тест-кейс(ов) для первых ${n(firstBatch)} — по ${n(requeued)} сценари(ям) тест-кейс не получился, они будут повторены в следующем пакете.`,
  planFirstIntroUnmapped: (drafted: number, firstBatch: number, unmapped: number) =>
    `Вот ${n(drafted)} тест-кейс(ов) для первых ${n(firstBatch)} — по ${n(unmapped)} из этих сценариев тест-кейс не получился.`,
  planFirstIntro: (firstBatch: number) => `Вот первые ${n(firstBatch)}.`,
  planStarted: (scenarios: number, intro: string, remaining: number, reply: string) =>
    `Я выделил(а) ${n(scenarios)} отдельных сценариев для покрытия. ${intro} Продолжаю генерировать остальные (ещё ${n(remaining)}) и опубликую их здесь по мере готовности; пока можете проверить эти.\n\n${reply}`,

  // zyraPlanBatchReply
  planNoteRequeued: (count: number) => ` По ${n(count)} сценари(ям) этого пакета тест-кейс не получился — они будут повторены в следующем пакете.`,
  planNoteSkipped: (count: number) => ` По ${n(count)} сценари(ям) тест-кейс не получился и после повтора — они пропущены.`,
  planNoteUnmapped: (count: number) => ` По ${n(count)} сценари(ям) этого пакета тест-кейс не получился.`,
  planBatchMore: (drafted: number, covered: number, total: number, notes: string, remaining: number) =>
    `Вот ещё ${n(drafted)} тест-кейс(ов) — покрыто сценариев: ${n(covered)}/${n(total)}.${notes} Работаю над оставшимися (${n(remaining)}); следующий пакет скоро.`,
  planBatchFinalAll: (drafted: number, total: number) =>
    `Вот последние ${n(drafted)} тест-кейс(ов) — все ${n(total)} сценариев покрыты. Проверьте их и скажите, если нужны изменения.`,
  planBatchFinalPartial: (drafted: number, covered: number, total: number, notes: string) =>
    `Вот последние ${n(drafted)} тест-кейс(ов) — покрыто ${n(covered)} из ${n(total)} сценариев; по ${n(total - covered)} тест-кейс не получился.${notes} Проверьте их и скажите, если нужны изменения.`,
  planMessageReasoning: "Продолжение пакетной генерации «все возможные кейсы».",

  // continueZyraChatPlan
  planNoKey: (reason: string) => `Не удалось продолжить генерацию тест-кейсов — ${reason}`,
  planGenerationDisabled:
    "Генерация тест-кейсов для Zyra в этом проекте была выключена, поэтому я остановил(а) генерацию оставшихся сценариев. Включите её в Zyra → Настройки → Возможности, чтобы продолжить.",
  planBatchSavedNothing: (batch: number) =>
    `⚠️ Этот пакет ничего не сохранил — ни один из ${n(batch)} сценариев не дал сохранённого тест-кейса.`,
  planBatchRetryLater: (count: number) => `${n(count)} из них будут повторены в следующем пакете.`,
  planContinuingRemaining: (count: number) => `Продолжаю с оставшимися (${n(count)}).`,
  planLastBatch: "Это был последний пакет.",
  planPausedOnError: (detail: string, covered: number, total: number) =>
    `При генерации тест-кейсов возникла проблема (${detail}). Ставлю на паузу — покрыто сценариев: ${n(covered)}/${n(total)}. Напишите «продолжить», и я повторю оставшиеся.`,

  // stop / resume
  planStopped: (done: number, total: number, remaining: number) =>
    `Остановлено по вашему запросу — покрыто сценариев: ${n(done)}/${n(total)}. Напишите «продолжить» в любой момент, и я продолжу с оставшимися (${n(remaining)}).`,
  planResuming: (done: number, total: number, remaining: number) =>
    `Продолжаю — покрыто сценариев: ${n(done)}/${n(total)}, осталось ${n(remaining)}.`,

  // timeouts and failures
  timedOut: [
    "⏱️ Провайдер ИИ не ответил вовремя — ничего не создано и не изменено, ничего не потеряно.",
    "Нажмите **Продолжить** ниже, и я продолжу с того же места, а не начну заново."
  ].join(" "),
  timedOutReasoning: (stage: string, timeoutMs: number, rest: string) =>
    `Вызов провайдера превысил время ожидания на этапе '${stage}' (${n(timeoutMs)} мс). ${rest}`,
  salvagedReasoning: (rest: string) =>
    `Ответ маршрутизатора дважды подряд не удалось разобрать как JSON; удалось восстановить лишь фрагменты текста, а не структурированное решение. ${rest}`,
  salvagedRouter:
    "Мой ответ оборвался раньше, чем я решил(а), что делать с запросом — ничего не создано, не обновлено и не изменено. Попробуйте ещё раз или запросите меньше тест-кейсов за раз, если запрос был большим.",
  retryNarrowed: (attempt: string, cause: string, batch: number, reply: string) =>
    [
      `⚠️ Первая попытка ${attempt} не удалась — ${cause}.`,
      `Я сменил(а) подход и повторил(а) с меньшим пакетом (${n(batch)}). Это сработало:`,
      "",
      reply,
      "",
      "Попросите продолжить, и я добавлю остальное пакетами такого же размера."
    ].join("\n"),

  // zyraFailureCause — same order and meaning as the English cause/advice pairs.
  failure: {
    truncated: {
      cause: "ответ ИИ пришёл неполным, и я не смог(ла) извлечь из него тест-кейсы",
      advice: "обычно помогает запросить меньше кейсов за раз — попробуйте «сгенерируй 5», и я буду строить дальше"
    },
    rateLimited: {
      cause: "провайдер ИИ сейчас ограничивает частоту запросов этого рабочего пространства",
      advice: "подождите минуту и спросите снова — с вашим запросом всё в порядке"
    },
    badKey: {
      cause: "провайдер ИИ отклонил ключ рабочего пространства",
      advice: "администратор может проверить ключ в Настройки → Провайдеры ИИ; пока это не исправлено, я ничего не смогу сгенерировать"
    },
    timeout: {
      cause: "провайдер ИИ не ответил вовремя",
      advice: "попробуйте ещё раз — если таймауты повторяются, меньший запрос проходит надёжнее"
    },
    noProvider: {
      cause: "для этого рабочего пространства не настроен провайдер ИИ",
      advice: "администратор может подключить его в Настройки → Провайдеры ИИ"
    },
    generic: {
      cause: "провайдер ИИ вернул ошибку",
      advice: "попробуйте ещё раз или сузьте запрос до меньшего числа кейсов"
    }
  },
  attemptCount: (count: number) => `${n(count)} тест-кейс(ов)`,
  attemptCountGeneric: "тест-кейсы",
  attemptKnowledge: (count: number) => `материалов базы знаний: ${n(count)}`,
  attemptJira: (count: number) => `тикетов Jira: ${n(count)}`,
  attemptGenerate: (target: string) => `сгенерировать ${target}`,
  attemptForSuite: (suiteName: string) => `для набора «${suiteName}»`,
  attemptFrom: (sources: string[]) => `на основе: ${sources.join(" и ")}`,
  attemptFromRequestOnly: "только по вашему запросу — в базе знаний ничего подходящего не нашлось",
  failureReply: (attempt: string, retried: boolean, cause: string, advice: string) =>
    [
      "⚠️ Возникла проблема, и я не смог(ла) это завершить — **ничего не создано и не сохранено.**",
      "",
      `**Что я пытался(лась) сделать:** ${attempt}.${retried ? " После неудачи я повторил(а) с меньшим пакетом, но и это не прошло." : ""}`,
      `**Что пошло не так:** ${cause}.`,
      `**Что можно сделать:** ${advice}.`
    ].join("\n"),

  // zyraDegradedDecision
  degradedNote: (reason: string) =>
    `⚠️ Провайдер ИИ Zyra сейчас недоступен (${reason}), поэтому это ответ только на основе репозитория тестов — тест-кейсы не созданы и не изменены.`,
  degradedRefuse: (note: string, intentIsCreate: boolean) =>
    `${note}\n\nЯ не могу ${intentIsCreate ? "генерировать тест-кейсы" : "изменять репозиторий тестов"}, пока провайдер недоступен. Проверьте Настройки → Провайдеры ИИ и спросите снова.`,
  degradedList: (note: string) => `${note}\n\nВот ближайшее существующее покрытие, которое я нашёл(ла).`,

  // capabilities
  capabilityLabel: {
    generation: "Генерация тест-кейсов",
    knowledgeBase: "Доступ к базе знаний",
    testcaseStorage: "Операции хранения тест-кейсов (создание, обновление, удаление, массовые)",
    suiteOperations: "Операции с наборами (создание, перемещение/назначение)"
  } as Record<string, string>,
  // Verb first: the labels differ in gender and number, so "<label> отключено" would not agree.
  capabilityDisabled: (label: string) =>
    `Для Zyra в этом проекте сейчас отключено: ${label}. Включите это в Zyra → Настройки → Возможности и попробуйте снова.`,
  storageGate: (reply: string) =>
    `Хранение тест-кейсов для Zyra в этом проекте отключено, поэтому это только предложения — я не сохранил(а) их. Включите «Операции хранения тест-кейсов» в Zyra → Настройки → Возможности, чтобы я мог(ла) сохранять сгенерированные тест-кейсы.\n\n${reply}`,

  // defaultZyraReply / defaultReasoningSummary
  defaultRelated: (count: number) =>
    `Я нашёл(ла) связанных тест-кейсов в репозитории: ${n(count)}. В целом я бы использовал(а) их как опорное покрытие, а затем искал(а) пробелы: негативные сценарии, граничные значения, права доступа, состояние данных и аудит. Попросите показать связанные тест-кейсы, если нужна таблица.`,
  defaultExample:
    "Пример: для функции сброса пароля я бы сначала описал(а) ожидаемый сценарий пользователя, затем риски — просроченные токены, повторно использованные ссылки, ограничение частоты, перебор учётных записей и задержки доставки писем. Строки тест-кейсов я создам, только если вы попросите их сгенерировать или сохранить.",
  defaultGeneric:
    "Я помогу с этим как ассистент по продукту с фокусом на QA. Сначала отвечу напрямую, а создавать, показывать или обновлять тест-кейсы буду, только когда вы об этом попросите.",
  defaultReasoning: (count: number) =>
    `Изучены доступные материалы базы знаний, недавний контекст чата и ближайшие тест-кейсы (${n(count)}). В фокусе — пробелы в покрытии, отсутствие дублей, граничные случаи и значения, права доступа, целостность данных, переходы состояний и аудит.`,

  // reconcileZyraReply and friends
  falseClaimBanner:
    "⚠️ **Извините! Ничего не сохранено.** Всё, что ниже описано как созданное, сохранённое или архивированное, не было выполнено — я это только описал(а).\n\nПопросите меня продолжить, и я внесу изменение и покажу затронутые тест-кейсы.",
  nothingSavedMissing: "Тест-кейсов, о которых шла речь, в этом проекте нет, поэтому менять было нечего.",
  nothingSavedNoOps: "Для этого запроса я не подготовил(а) ни одной операции с тест-кейсами.",
  nothingStagedNoChange: (count: number) =>
    `⚠️ Ничего не подготовлено для проверки. Предложенное обновление не меняло ни одного поля (тест-кейсов: ${n(count)}), поэтому тест-кейсы остались без изменений — попросите ещё раз и уточните, что нужно изменить.`,
  nothingSaved: (detail: string) =>
    `⚠️ Ничего не сохранено. ${detail} Попросите сгенерировать тест-кейсы, и я сразу подготовлю их для проверки.`,
  reviewHint: (count: number) =>
    `\n\n📝 Ожидают вашей проверки: ${n(count)} — откройте панель проверки, чтобы выбрать, отредактировать или отклонить, затем нажмите «Сохранить», чтобы добавить в репозиторий. В репозиторий пока ничего не записано.`,
  partialHeadline: (applied: number, requested: number) => `Подготовлено для проверки операций с тест-кейсами: ${n(applied)} из ${n(requested)}.`,
  partialUnresolvedMoves: (count: number) => `Не удалось переместить названные тест-кейсы: ${n(count)}.`,
  partialRestNotDrafted: " Остальные не подготовлены.",
  movedToSuites: (parts: string[], total: number) => `\n\n📦 **Перемещено в наборы (фактически):** ${parts.join(" · ")} — всего тест-кейсов: ${n(total)}.`,
  moveSuiteCreated: (suiteName: string) => `${suiteName} (создан)`,
  moveNoneMatched: (label: string) => `${label}: 0 (ничего не найдено)`,
  strippedTable:
    "_Эти тест-кейсы были только описаны в чате — в репозиторий они не сохранены. Попросите их сгенерировать, и они будут созданы и показаны в таблице выше._",

  // Jira coverage tool
  jiraCoverage: (total: number, covered: number, pending: number, linked: number, pct: number | string, hasPending: boolean) =>
    [
      "Я проверил(а) кэш тикетов Jira и связи с тест-кейсами для этого проекта.",
      `Всего тикетов Jira: ${n(total)}.`,
      `Тикетов хотя бы с одним активным связанным тест-кейсом: ${n(covered)}.`,
      `Тикетов, ожидающих написания тест-кейсов: ${n(pending)}.`,
      `Активных связанных тест-кейсов по покрытым тикетам: ${n(linked)}.`,
      `Покрытие по тикетам Jira: ${pct}%.`,
      hasPending ? "Ожидающие тикеты перечислены в таблице." : "Сейчас нет тикетов Jira без покрытия тест-кейсами."
    ].join("\n"),
  jiraNotSynced:
    "Jira подключена, но синхронизированных тикетов Jira в локальном кэше пока нет. Сначала запустите синхронизацию Jira, затем спросите снова — я посчитаю покрытие.",
  jiraNotConnected:
    "Jira для этого проекта ещё не подключена, поэтому я не могу посчитать покрытие тест-кейсами. Сначала подключите Jira и синхронизируйте тикеты."
};

const L = "(?<![\\p{L}\\p{N}])"; // start of a word, in any script
const R = "(?![\\p{L}\\p{N}])"; // end of a word, in any script

/** Whole-message "yes" — the Russian half of ZYRA_AFFIRMATIVE_PATTERN, tested on folded (ё→е) text. */
export const ZYRA_RU_AFFIRMATIVE =
  /^(да|да,?\s*пожалуйста|ага|угу|конечно|ок|окей|хорошо|подтверждаю|верно|давай|давайте|делай|сделай|сделай это|вперед|согласен|согласна|продолжай)[\s.!]*$/iu;

/** "continue" — the Russian half of isZyraResumeIntent. */
// The verb forms only: a bare stem would also match "продолжительность" (duration).
export const ZYRA_RU_RESUME = new RegExp(
  `${L}(продолжи|продолжай|продолжайте|продолжите|продолжить|продолжим|продолжаем|возобнови|возобновите|возобновить|дальше)${R}`,
  "iu"
);

/** An offer to act, ending in a question — the Russian half of ZYRA_OFFER_PATTERN. */
export const ZYRA_RU_OFFER = new RegExp(
  `${L}(хотите|хочешь|нужно ли|могу ли я|мне)${R}[^.!?\\n]{0,120}${L}(созда|сгенер|генер|добав|напис|подготов|архивир|удал|обнов|измен|перемест|назнач|упоряд)\\p{L}*[^.!?\\n]{0,120}\\?`,
  "iu"
);

/** Drafts staged and awaiting the user — the Russian half of ZYRA_STAGED_AWAITING_PATTERN. */
export const ZYRA_RU_STAGED_AWAITING = new RegExp(
  `${L}(подготовлен|предложен)\\p{L}*[^.!?\\n]{0,60}(на проверку|для проверки|ожида\\p{L}* (вашей )?проверки)` +
    `|${L}ничего не (изменено|записано|сохранено)[^.!?\\n]{0,100}пока вы не сохраните` +
    `|${L}ожида\\p{L}* (вашего )?(подтверждения|одобрения)`,
  "iu"
);

/*
 * A past-tense claim that test cases were created/saved/changed — the Russian half of
 * ZYRA_COMPLETION_CLAIM, so a Russian reply is held to the same "never claim staged work as done"
 * rule. Past participles/verbs (созданы, сохранил, добавлено…) near a test case/suite/repository
 * noun, in either order; "будут созданы", "не созданы", "ещё не" are not claims.
 */
// stem + past-tense or past-participle ending: создал/созданы, сохранил/сохранены, добавил/добавлены,
// обновил/обновлены, архивировал/архивирован, удалил/удалены, переместил/перемещены.
const RU_CLAIM_VERB =
  "(созда|сохрани|сохран|добави|добавл|обнови|обновл|архивирова|удали|удал|перемести|перемещ)(л|ла|ло|ли|н|на|но|ны|ен|ена|ено|ены)";
const RU_CLAIM_NOUN = "(тест-кейс|кейс|набор|репозитори)\\p{L}*";
const RU_NOT_A_CLAIM = "(?<!(?:не|будут|будет|будем|будете|ещё не|еще не|можно|нужно)\\s)";
export const ZYRA_RU_COMPLETION_CLAIM = new RegExp(
  `${L}${RU_NOT_A_CLAIM}${RU_CLAIM_VERB}${R}[^.!?\\n]{0,80}${L}${RU_CLAIM_NOUN}` +
    `|${L}${RU_CLAIM_NOUN}[^.!?\\n,;]{0,40}${L}${RU_NOT_A_CLAIM}${RU_CLAIM_VERB}${R}`,
  "iu"
);

/** Our own Russian disclosures, exempt from the claim check — the Russian half of ZYRA_ALREADY_DISCLOSED. */
export const ZYRA_RU_ALREADY_DISCLOSED = new RegExp(
  `${L}(ничего не (сохранено|создано|изменено|записано|сгенерировано)` +
    `|тест-кейсы не (созданы|сохранены|изменены)` +
    `|не удалось (создать|сохранить|сгенерировать|архивировать|обновить|добавить)` +
    `|я не сохранил\\p{L}*` +
    `|генерация (выключена|отключена)` +
    `|ожида\\p{L}* (вашей )?проверки` +
    `|пока вы не сохраните` +
    `|не (сохранен|записан)\\p{L}* в репозитори)`,
  "iu"
);

/** Text folded the way the Russian patterns expect: ё and е are one letter. */
export function foldRu(text: string): string {
  return text.replace(/ё/g, "е").replace(/Ё/g, "Е");
}
