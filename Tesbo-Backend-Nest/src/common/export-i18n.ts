/*
 * Localized labels for generated files (test case / test run / report exports and the import
 * template), and the reverse mapping the importer needs to read those files back.
 *
 * Only FIXED labels are translated: column headers, sheet names, the report's section/metric keys,
 * and the product's own enum vocabularies (test case status, type, severity, automation type,
 * execution / run / bug status, report health labels). Anything a user typed — titles, steps, suite
 * names, custom field names and option labels — and model-written text such as the reports' AI
 * summary passes through untouched. A value missing from a table (a status someone stored as free
 * text, say) is exported as-is rather than dropped.
 *
 * English output is byte-for-byte what the exports produced before this file existed: headers stay
 * the camelCase keys, values stay the stored vocabulary. Every English export, and every integration
 * parsing one, keeps working.
 *
 * The database keeps storing the English vocabulary regardless of the locale a file was exported in.
 * Without canonicalizeImportValue, re-importing a Russian export would save "Черновик" as a brand-new
 * test case status (prepareImportRow does not validate these columns), and every count/filter that
 * matches on 'Draft' would silently miss the row.
 *
 * Adding a language: add it to EXPORT_LOCALES and give it a column in each table below.
 */

export const EXPORT_LOCALES = ["en", "ru"] as const;
export type ExportLocale = (typeof EXPORT_LOCALES)[number];

/** Prepended to CSV bodies so Excel on Windows decodes them as UTF-8 instead of the ANSI codepage. */
export const UTF8_BOM = "﻿";

function supportedLocale(tag: string): ExportLocale | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return (EXPORT_LOCALES as readonly string[]).includes(primary) ? (primary as ExportLocale) : null;
}

/**
 * Picks the export language: an explicit `lang` query value wins (so an English browser can still
 * ask for a Russian file), otherwise the browser's Accept-Language, highest q first, otherwise
 * English. Malformed or unsupported input never throws — it falls back to English, because a
 * download should never fail over a language preference.
 */
export function resolveExportLocale(acceptLanguage: string | string[] | undefined, override?: unknown): ExportLocale {
  if (typeof override === "string" && override.trim()) {
    const explicit = supportedLocale(override);
    if (explicit) return explicit;
  }
  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(",") : acceptLanguage;
  if (!header) return "en";
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.split(";");
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qParam === undefined ? 1 : Number(qParam.slice(2));
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    // Stable on equal q: the browser's own order breaks the tie.
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of ranked) {
    const locale = supportedLocale(entry.tag);
    if (locale) return locale;
  }
  return "en";
}

type Dictionary = Record<string, string>;

// Column headers, keyed by the internal key every export already uses as its English header.
const RU_HEADERS: Dictionary = {
  // Test cases + import template
  externalId: "ID",
  title: "Название",
  description: "Описание",
  preconditions: "Предусловия",
  postconditions: "Постусловия",
  steps: "Шаги",
  action: "Действие",
  expectedResult: "Ожидаемый результат",
  testData: "Тестовые данные",
  priority: "Приоритет",
  severity: "Серьёзность",
  type: "Тип",
  status: "Статус",
  suite: "Набор",
  component: "Компонент",
  estimatedDuration: "Оценка времени",
  automationStatus: "Тип автоматизации",
  attachments: "Примечания",
  // Test run
  actualResult: "Фактический результат",
  executedAt: "Дата выполнения",
  defectKey: "Ключ дефекта",
  defectUrl: "Ссылка на дефект",
  // Reports — long form
  section: "Раздел",
  label: "Метка",
  metric: "Показатель",
  value: "Значение",
  // Reports — execution
  groupName: "Группа",
  Passed: "Пройдено",
  Failed: "Провалено",
  Blocked: "Заблокировано",
  Skipped: "Пропущено",
  Untested: "Не протестировано",
  Retest: "Повторная проверка",
  total: "Всего",
  // Reports — traceability matrix
  testcaseTitle: "Тест-кейс",
  testcaseStatus: "Статус тест-кейса",
  suiteName: "Набор",
  runName: "Тестовый прогон",
  runStatus: "Статус прогона",
  executionStatus: "Статус выполнения",
  bugTitle: "Баг",
  bugStatus: "Статус бага",
  bugUrl: "Ссылка на баг"
};

const RU_SHEETS: Dictionary = {
  "Test Cases": "Тест-кейсы",
  Overview: "Обзор",
  "Execution Report": "Отчёт о выполнении",
  Traceability: "Трассируемость",
  Repository: "Репозиторий",
  "AI Insights": "Аналитика ИИ",
  Trends: "Тренды"
};

const RU_REPORT_SECTIONS: Dictionary = {
  summary: "Сводка",
  passRateTrend: "Динамика прохождения",
  suiteHealth: "Состояние наборов",
  bySuite: "По наборам",
  byStatus: "По статусам",
  byPriority: "По приоритетам",
  addedByDate: "Добавлено по датам",
  flakyTests: "Нестабильные тесты",
  coverageGaps: "Пробелы в покрытии",
  coverageBySuite: "Покрытие по наборам",
  executionVelocity: "Скорость выполнения",
  bugDiscoveryRate: "Обнаружение багов"
};

const RU_REPORT_METRICS: Dictionary = {
  trendDelta: "Изменение тренда",
  flakyCount: "Нестабильных тестов",
  coverageGapCount: "Пробелов в покрытии",
  untestedP1Count: "Непротестированных P1",
  aiSummary: "Сводка ИИ",
  total: "Всего",
  executed: "Выполнено",
  passRate: "Процент прохождения",
  createdAt: "Дата создания",
  passedPct: "% пройдено",
  failedPct: "% провалено",
  blockedPct: "% заблокировано",
  totalTestCases: "Всего тест-кейсов",
  updatedToday: "Обновлено сегодня",
  updatedThisWeek: "Обновлено за неделю",
  updatedThisMonth: "Обновлено за месяц",
  count: "Количество",
  healthScore: "Оценка состояния",
  healthLabel: "Состояние",
  title: "Название",
  suiteName: "Набор",
  flipCount: "Смен статуса",
  flakinessLabel: "Нестабильность",
  covered: "Покрыто",
  pct: "% покрытия"
};

/** Which vocabulary a cell's value belongs to. Priority (P0–P3) is deliberately absent: it reads the same in every language. */
export type ExportValueField =
  | "testcaseStatus"
  | "type"
  | "severity"
  | "automationStatus"
  | "executionStatus"
  | "runStatus"
  | "bugStatus"
  | "healthLabel"
  | "flakinessLabel";

const RU_VALUES: Record<ExportValueField, Dictionary> = {
  testcaseStatus: {
    Draft: "Черновик",
    "In Review": "На проверке",
    Approved: "Утверждён",
    Deprecated: "Устаревший",
    Archived: "В архиве"
  },
  type: {
    Functional: "Функциональный",
    Regression: "Регрессионный",
    Smoke: "Смоук",
    Sanity: "Санити",
    Integration: "Интеграционный",
    // API / UI are the same word in Russian QA usage, so they export unchanged.
    Performance: "Производительность",
    Security: "Безопасность"
  },
  severity: { Critical: "Критическая", High: "Высокая", Medium: "Средняя", Low: "Низкая" },
  automationStatus: {
    Automated: "Автоматизирован",
    "Not Automated": "Не автоматизирован",
    "Can't Automate": "Невозможно автоматизировать"
  },
  executionStatus: {
    Untested: "Не протестирован",
    Passed: "Пройден",
    Failed: "Провален",
    Blocked: "Заблокирован",
    Skipped: "Пропущен",
    Retest: "Повторная проверка"
  },
  runStatus: { Planning: "Планирование", "In Progress": "В процессе", Completed: "Завершён" },
  bugStatus: { Open: "Открыт", "In Progress": "В работе", Reopened: "Переоткрыт", Closed: "Закрыт" },
  healthLabel: { Healthy: "Хорошее", "Needs attention": "Требует внимания", "At risk": "Под угрозой" },
  flakinessLabel: { High: "Высокая", Medium: "Средняя", Low: "Низкая" }
};

function lookup(locale: ExportLocale, table: Dictionary, key: string): string {
  if (locale === "en") return key;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
}

export function exportHeader(locale: ExportLocale, key: string): string {
  return lookup(locale, RU_HEADERS, key);
}

export function exportSheetName(locale: ExportLocale, englishName: string): string {
  return lookup(locale, RU_SHEETS, englishName);
}

export function exportReportSection(locale: ExportLocale, section: string): string {
  return lookup(locale, RU_REPORT_SECTIONS, section);
}

export function exportReportMetric(locale: ExportLocale, metric: string): string {
  return lookup(locale, RU_REPORT_METRICS, metric);
}

/** Translates one stored enum value. Non-strings (numbers, dates, null) and unknown values pass through. */
export function exportValue(locale: ExportLocale, field: ExportValueField, value: unknown): unknown {
  if (locale === "en" || typeof value !== "string") return value;
  return lookup(locale, RU_VALUES[field], value);
}

/**
 * Builds a row keyed by the localized headers from a row keyed by internal keys, translating the
 * cells whose column carries a known vocabulary. The returned headers are in the same order as
 * `keys`, ready for rowsToCsv / sendWorkbook.
 *
 * `userKeys` are columns named by the user (custom fields): their header is never translated, even
 * when a field happens to be called "label" or "total" — words this file has a translation for.
 */
export function localizeRows(
  locale: ExportLocale,
  keys: string[],
  rows: Record<string, unknown>[],
  valueFields: Partial<Record<string, ExportValueField>> = {},
  userKeys: Iterable<string> = []
): { headers: string[]; rows: Record<string, unknown>[] } {
  if (locale === "en") return { headers: keys, rows };
  const untranslated = new Set(userKeys);
  const headers = keys.map((key) => (untranslated.has(key) ? key : exportHeader(locale, key)));
  const localized = rows.map((row) => {
    const out: Record<string, unknown> = {};
    keys.forEach((key, index) => {
      const field = valueFields[key];
      out[headers[index]] = field ? exportValue(locale, field, row[key]) : row[key];
    });
    return out;
  });
  return { headers, rows: localized };
}

function foldForMatch(value: string): string {
  // ё/е are used interchangeably in everyday Russian typing; treat them as one letter.
  return value.trim().toLowerCase().replace(/ё/g, "е");
}

const REVERSE_VALUES: Record<ExportValueField, Map<string, string>> = Object.fromEntries(
  (Object.keys(RU_VALUES) as ExportValueField[]).map((field) => [
    field,
    new Map(Object.entries(RU_VALUES[field]).map(([english, russian]) => [foldForMatch(russian), english]))
  ])
) as Record<ExportValueField, Map<string, string>>;

/**
 * Maps a translated label back to the stored English vocabulary, so a re-imported Russian file
 * stores "Draft", not "Черновик". Anything that is not a known translation — including English
 * values in any case — comes back unchanged, which keeps the importer's existing behaviour for
 * every file it accepted before.
 */
export function canonicalizeImportValue(field: ExportValueField, raw: string): string {
  return REVERSE_VALUES[field].get(foldForMatch(raw)) ?? raw;
}

/**
 * Whether `name` reads as one of the given base columns' localized headers once normalized the way
 * the import modal normalizes headers (case-folded, letters and digits only — in any script).
 * normalizeTestcaseHeader can't answer this: it keeps only a-z0-9, so every Cyrillic name folds to "".
 */
export function collidesWithLocalizedHeader(locale: ExportLocale, name: string, keys: Iterable<string>): boolean {
  if (locale === "en") return false;
  const normalize = (value: string) => foldForMatch(value).replace(/[^\p{L}\p{N}]+/gu, "");
  const target = normalize(name);
  if (!target) return false;
  for (const key of keys) {
    if (normalize(exportHeader(locale, key)) === target) return true;
  }
  return false;
}
