/*
 * Russian display text for a Zyra task's activity timeline and source list, applied by formatAiTask
 * to a task whose language is "ru" (ai_generation_requests.language).
 *
 * Translated on the way OUT, not when written: activity_log keeps the English it has always stored,
 * so nothing that reads the column (the board's own logic, reports, the backend specs) changes, and
 * a task created before this existed renders in Russian the moment its language says so.
 *
 * Only Zyra's own fixed wording is translated. Anything a person or a model wrote — the story, the
 * feedback text, a draft title, a provider error — is left exactly as it is. An entry this table
 * does not recognise passes through unchanged.
 */

type Entry = Record<string, unknown>;

const TITLES: Record<string, string> = {
  "Task created": "Задача создана",
  "Waiting for Zyra": "Ожидает Zyra",
  "Not linked to a ticket": "Не привязано к тикету",
  "Generation failed": "Генерация не удалась",
  "Generation failed after task was already updated": "Генерация не удалась после обновления задачи",
  "Picked up task": "Задача взята в работу",
  "Read available sources": "Изучены доступные источники",
  "Generation plan": "План генерации",
  "Generated testcase drafts": "Сгенерированы черновики тест-кейсов",
  "Generated drafts discarded": "Сгенерированные черновики отброшены",
  "Accepted and saved testcases": "Тест-кейсы приняты и сохранены",
  "Review feedback submitted": "Отправлен отзыв ревьюера",
  "Moved task back to Todo": "Задача возвращена в «К выполнению»",
  "Re-read sources with feedback": "Источники перечитаны с учётом отзыва",
  "Regenerated testcase drafts": "Черновики тест-кейсов перегенерированы",
  "Regenerated drafts discarded": "Перегенерированные черновики отброшены",
  "Deleted testcase draft": "Черновик тест-кейса удалён",
  "Edited testcase draft": "Черновик тест-кейса отредактирован",
  "Closed task": "Задача закрыта",
  "Target suite no longer available": "Целевой набор больше недоступен",
  // source list
  "User story": "Пользовательская история",
  "User Story Context": "Контекст пользовательской истории",
  "Reviewer reference": "Ссылка ревьюера"
};

const FIXED_DETAILS: Record<string, string> = {
  "Zyra will pick up this task and move it to In Progress.": "Zyra возьмёт эту задачу и переведёт её в работу.",
  "Zyra moved this task from Todo to In Progress.": "Zyra перевела задачу из «К выполнению» в «В работе».",
  "Zyra queued the task again after reviewer feedback.": "Zyra снова поставила задачу в очередь после отзыва ревьюера.",
  "Task closed from review without saving additional testcase drafts.": "Задача закрыта на проверке без сохранения дополнительных черновиков.",
  "Linked from the selected Knowledge Base document.": "Привязано из выбранного документа базы знаний.",
  "Selected Jira ticket queued for Zyra.": "Выбранный тикет Jira передан Zyra.",
  "Selected Linear ticket queued for Zyra.": "Выбранный тикет Linear передан Zyra.",
  "Referenced by reviewer feedback.": "Упомянуто в отзыве ревьюера."
};

function sourceLabel(label: string): string {
  if (label === "explicitly selected") return "выбраны явно";
  if (label === "no strong match, showing recent documents") return "точного совпадения нет, показаны последние документы";
  const match = /^semantic\/keyword match, confidence: (\w+)$/.exec(label);
  if (match) return `семантическое/ключевое совпадение, уверенность: ${match[1] === "strong" ? "высокая" : match[1] === "weak" ? "низкая" : match[1]}`;
  return label;
}

function signals(text: string): string {
  if (text === "the submitted story") return "переданную историю";
  return text
    .split(", ")
    .map((part) => {
      if (part === "project context") return "контекст проекта";
      if (part === "acceptance criteria") return "критерии приёмки";
      if (part === "review feedback") return "отзыв ревьюера";
      let m = /^(\d+) knowledge-base source\(s\)$/.exec(part);
      if (m) return `источники базы знаний (${m[1]})`;
      m = /^(\d+) Jira ticket\(s\)$/.exec(part);
      if (m) return `тикеты Jira (${m[1]})`;
      m = /^(\d+) Linear ticket\(s\)$/.exec(part);
      if (m) return `тикеты Linear (${m[1]})`;
      return part;
    })
    .join(", ");
}

const DETAIL_PATTERNS: Array<[RegExp, (...groups: string[]) => string]> = [
  [
    /^Considered (\d+) knowledge-base item\(s\) \((.*)\), (\d+) Jira ticket\(s\), (\d+) Linear ticket\(s\), (\d+) existing testcase\(s\), Zyra memory, and the supplied story\/context\.$/,
    (kb, label, jira, linear, existing) =>
      `Учтено: материалы базы знаний — ${kb} (${sourceLabel(label)}), тикеты Jira — ${jira}, тикеты Linear — ${linear}, существующие тест-кейсы — ${existing}, память Zyra и указанная история/контекст.`
  ],
  [
    /^Reused the same task and applied feedback against (\d+) knowledge-base item\(s\) \((.*)\), (\d+) Jira ticket\(s\), (\d+) Linear ticket\(s\), (\d+) existing testcase\(s\), Zyra memory, and (the referenced docs\/tickets|the existing context)\.$/,
    (kb, label, jira, linear, existing, tail) =>
      `Та же задача, отзыв применён с учётом: материалы базы знаний — ${kb} (${sourceLabel(label)}), тикеты Jira — ${jira}, тикеты Linear — ${linear}, существующие тест-кейсы — ${existing}, память Zyra и ${tail === "the referenced docs/tickets" ? "упомянутые документы/тикеты" : "существующий контекст"}.`
  ],
  [
    /^I checked (.+) and planned coverage across happy path, negative, boundary, permission, data-state, and traceability risks before drafting the testcases\.$/,
    (checked) =>
      `Я изучил(а) ${signals(checked)} и спланировал(а) покрытие: позитивные и негативные сценарии, граничные значения, права доступа, состояние данных и трассируемость — до написания тест-кейсов.`
  ],
  [
    /^Generated (\d+) testcase draft\(s\) with (\S+?)(?: request (\S+))?\. Cached input tokens: (\d+)\.$/,
    (count, provider, request, cached) =>
      `Сгенерировано черновиков тест-кейсов: ${count} через ${provider}${request ? ` (запрос ${request})` : ""}. Кэшированных входных токенов: ${cached}.`
  ],
  [
    /^Updated this task with (\d+) regenerated draft\(s\)\. Cached input tokens: (\d+)\.$/,
    (count, cached) => `Задача обновлена, перегенерировано черновиков: ${count}. Кэшированных входных токенов: ${cached}.`
  ],
  [/^Saved (\d+) testcase\(s\)\.$/, (count) => `Сохранено тест-кейсов: ${count}.`],
  [
    /^Zyra finished generating (\d+) testcase draft\(s\), but the task had already been updated in the meantime, so these drafts were not applied\.$/,
    (count) => `Zyra сгенерировала черновиков: ${count}, но задача за это время уже изменилась, поэтому они не применены.`
  ],
  [
    /^Zyra regenerated (\d+) testcase draft\(s\) after this feedback, but the task had already been updated elsewhere in the meantime, so the regenerated drafts were not applied\.$/,
    (count) => `Zyra перегенерировала черновиков после отзыва: ${count}, но задача за это время уже изменилась, поэтому они не применены.`
  ],
  [
    /^(\d+) target suite\(s\) had been deleted since these drafts were staged\. Affected new test case\(s\) were saved unassigned instead of failing the batch\.$/,
    (count) =>
      `Целевых наборов удалено с момента подготовки черновиков: ${count}. Затронутые новые тест-кейсы сохранены без набора, чтобы не прерывать пакет.`
  ]
];

// Entries whose detail is someone else's text — the story, a source excerpt, a provider error, a
// draft's title — and is never rewritten, even if it happens to read like one of the patterns above.
const USER_TEXT_DETAIL_TITLES = new Set([
  "Task created",
  "User story",
  "User Story Context",
  "Reviewer reference",
  "Generation failed",
  "Generation failed after task was already updated"
]);

function localizeDetail(detail: string, englishTitle: unknown): string {
  if (typeof englishTitle !== "string" || USER_TEXT_DETAIL_TITLES.has(englishTitle)) return detail;
  // A deleted/edited draft's detail is its title, or "Draft N" when it has none.
  if (englishTitle === "Deleted testcase draft" || englishTitle === "Edited testcase draft") {
    const draft = /^Draft (\d+)$/.exec(detail);
    return draft ? `Черновик ${draft[1]}` : detail;
  }
  // Review feedback: the reviewer's own text stays; only our line prefixes are translated.
  if (englishTitle === "Review feedback submitted") {
    return detail
      .replace(/^References: /m, "Ссылки: ")
      .replace(/^Jira tickets: /m, "Тикеты Jira: ")
      .replace(/^Linear tickets: /m, "Тикеты Linear: ");
  }
  if (Object.prototype.hasOwnProperty.call(FIXED_DETAILS, detail)) return FIXED_DETAILS[detail];
  for (const [pattern, render] of DETAIL_PATTERNS) {
    const match = pattern.exec(detail);
    if (match) return render(...match.slice(1));
  }
  return detail;
}

export function localizeZyraTaskEntry<T extends Entry>(entry: T): T {
  if (!entry || typeof entry !== "object") return entry;
  const out: Entry = { ...entry };
  if (typeof out.title === "string" && Object.prototype.hasOwnProperty.call(TITLES, out.title)) out.title = TITLES[out.title];
  if (typeof out.detail === "string") out.detail = localizeDetail(out.detail, entry.title);
  return out as T;
}
