import { detectScriptLanguage } from "./script-language";

describe("detectScriptLanguage", () => {
  it.each([
    ["Создай тест-кейсы для страницы входа", "ru"],
    ["Create test cases for the login page", "en"],
    // Majority wins, in both directions.
    ["Создай тест-кейсы для login page на мобильном", "ru"],
    ["Create test cases for the экран входа on mobile", "en"],
    // English quoting a Russian name stays English.
    ["Verify the city field accepts «Москва» and saves it", "en"],
    // Latin noise does not outvote the Russian around it.
    ["Проверь страницу https://example.com/login/very/long/path?with=query HBP-14 AIP-TC-73", "ru"],
    ["Напиши тесты для user.name@example.com и `validateEmailAddressFormat()`", "ru"],
    ["Сценарии:\n```\nconst foo = bar.baz(qux);\n```\nдля входа", "ru"],
    // ё/е and case.
    ["СОЗДАЙ ТЕСТЫ ДЛЯ ВХОДА", "ru"],
    ["Проверь всё ещё ёлку", "ru"],
    // Cyrillic that is not Russian falls back to English.
    ["Створи тест-кейси для сторінки входу", "en"],
    ["Кіру бетіне арналған тест жағдайларын жаса", "en"],
    ["Направи тест случајеве за пријаву", "en"],
    ["Стварыце тэсты для ўваходу", "en"],
    // Transliterated Russian is Latin script.
    ["sozdai testy dlya stranitsy vhoda", "en"],
  ])("%j is %s", (text, expected) => {
    expect(detectScriptLanguage(text)).toBe(expected);
  });

  it.each([
    ["ok"],
    ["да"],
    ["yes"],
    ["Да, ок"],
    ["5"],
    ["👍"],
    ["HBP-14"],
    ["https://example.com/a/very/long/url/with/many/latin/letters"],
    ["   "],
    [""],
  ])("%j carries no signal", (text) => {
    expect(detectScriptLanguage(text)).toBeNull();
  });

  it("is null for anything that is not a string", () => {
    expect(detectScriptLanguage(undefined)).toBeNull();
    expect(detectScriptLanguage(null)).toBeNull();
    expect(detectScriptLanguage(42)).toBeNull();
  });
});
