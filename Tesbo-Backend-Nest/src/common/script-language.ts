import type { ExportLocale } from "./export-i18n";

/*
 * The language a piece of user-typed text is written in, judged from its Unicode script — not from
 * the browser's Accept-Language. Zyra writes in the language the user writes to it in: a Russian
 * message from an English browser gets Russian, an English message from a Russian browser English.
 *
 * English is the default and Russian has to be earned. The rule, in order:
 *
 *   1. Noise that is Latin whatever language surrounds it is removed first: URLs, email addresses,
 *      ticket keys (HBP-14, AIP-TC-73) and `code`. Otherwise "Проверь https://example.com/login
 *      HBP-14" counts more Latin letters than Cyrillic ones.
 *   2. Fewer than MIN_LETTERS letters left ("ok", "да", "5", "👍", a bare ticket key) is no signal:
 *      null, and the caller keeps whatever language it already had. A Russian user replying "ok" to
 *      a Russian conversation must not flip it to English.
 *   3. Cyrillic letters under half of the remaining letters: English. English text quoting a Russian
 *      name ("check the city «Москва» is accepted") stays English.
 *   4. A Cyrillic majority containing a letter Russian does not use (Ukrainian і ї є ґ, Belarusian ў,
 *      Serbian/Macedonian ђ ј љ њ ћ џ ѓ ќ ѕ, Kazakh ә ғ қ ң ө ұ ү һ): English. Answering a Ukrainian
 *      or Kazakh speaker in Russian is worse than answering in English. Known gap: Bulgarian has no
 *      letter of its own, so it reads as Russian.
 *   5. Otherwise: Russian.
 *
 * Transliterated Russian ("sozdai testy") is Latin script and therefore English, by design.
 */

const MIN_LETTERS = 8;

const NOISE = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /[^\s@]+@[^\s@]+\.[^\s@]+/g,
  /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+\b/g
];

const NON_RUSSIAN_CYRILLIC = /[іїєґўђјљњћџѓќѕәғқңөұүһІЇЄҐЎЂЈЉЊЋЏЃЌЅӘҒҚҢӨҰҮҺ]/;

export function detectScriptLanguage(text: unknown): ExportLocale | null {
  if (typeof text !== "string" || !text) return null;
  let cleaned = text;
  for (const pattern of NOISE) cleaned = cleaned.replace(pattern, " ");
  const cyrillic = cleaned.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = cleaned.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillic + latin < MIN_LETTERS) return null;
  if (cyrillic * 2 < cyrillic + latin) return "en";
  return NON_RUSSIAN_CYRILLIC.test(cleaned) ? "en" : "ru";
}
