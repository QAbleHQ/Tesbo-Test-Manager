import {
  foldRu,
  ZYRA_RU,
  ZYRA_RU_AFFIRMATIVE,
  ZYRA_RU_ALREADY_DISCLOSED,
  ZYRA_RU_COMPLETION_CLAIM,
  ZYRA_RU_OFFER,
  ZYRA_RU_RESUME,
  ZYRA_RU_STAGED_AWAITING
} from "./zyra-replies-ru";

const test = (pattern: RegExp, text: string) => pattern.test(foldRu(text));

describe("Russian Zyra reply patterns", () => {
  it.each(["да", "Да!", "да, пожалуйста", "Давай", "ок", "Хорошо.", "подтверждаю", "Вперёд", "сделай это"])(
    "%j is a confirmation",
    (text) => expect(test(ZYRA_RU_AFFIRMATIVE, text.trim())).toBe(true)
  );

  it.each(["да, но без архивации", "нет", "не надо", "давай подумаем", "дальше видно будет что делать"])(
    "%j is not a bare confirmation",
    (text) => expect(test(ZYRA_RU_AFFIRMATIVE, text.trim())).toBe(false)
  );

  it.each(["продолжить", "Продолжай", "давай дальше", "возобнови генерацию", "продолжи, пожалуйста"])(
    "%j asks to resume",
    (text) => expect(test(ZYRA_RU_RESUME, text)).toBe(true)
  );

  // "Продолжительность" (duration) starts with the same letters — a stem match must not count it.
  it.each(["стоп", "покажи тест-кейсы", "Продолжительность сессии 20 минут"])("%j does not ask to resume", (text) => {
    expect(test(ZYRA_RU_RESUME, text)).toBe(false);
  });

  it.each([
    "Хотите, чтобы я сгенерировал тест-кейсы для входа?",
    "Мне подготовить ещё 5 сценариев?",
    "Нужно ли архивировать TC-5?"
  ])("%j is an offer", (text) => expect(test(ZYRA_RU_OFFER, text)).toBe(true));

  it("a clarifying question is not an offer", () => {
    expect(test(ZYRA_RU_OFFER, "Какой модуль покрыть в первую очередь?")).toBe(false);
  });

  it.each([
    "9 обновлений подготовлены для проверки — ничего не изменено, пока вы не сохраните.",
    "Ожидаю вашего подтверждения."
  ])("%j is staged-and-awaiting", (text) => expect(test(ZYRA_RU_STAGED_AWAITING, text)).toBe(true));

  it.each([
    "Тест-кейсы созданы и сохранены в набор Login.",
    "Я создал 7 тест-кейсов.",
    "Сохранил тест-кейсы в репозиторий.",
    "TC-5 архивирован, тест-кейс удалён."
  ])("%j claims completed work", (text) => expect(test(ZYRA_RU_COMPLETION_CLAIM, text)).toBe(true));

  it.each([
    "Тест-кейсы будут созданы после вашего сохранения.",
    "Я подготовил 7 тест-кейсов для проверки.",
    "Тест-кейсы не созданы.",
    "Предлагаю набор из 5 тест-кейсов."
  ])("%j is not a completion claim", (text) => expect(test(ZYRA_RU_COMPLETION_CLAIM, text)).toBe(false));

  it.each([
    ZYRA_RU.failureReply("сгенерировать 5 тест-кейс(ов)", true, "причина", "совет"),
    ZYRA_RU.degradedNote("нет ключа"),
    ZYRA_RU.storageGate(""),
    ZYRA_RU.reviewHint(3),
    ZYRA_RU.timedOut
  ])("Zyra's own Russian disclosure %# is exempt from the claim check", (text) => {
    expect(test(ZYRA_RU_ALREADY_DISCLOSED, text)).toBe(true);
  });

  it("no English text matches a Russian pattern — English behaviour cannot change", () => {
    const english = [
      "yes",
      "continue",
      "Would you like me to generate test cases?",
      "Created 7 test cases in the Login suite.",
      "9 updates are staged for your review — nothing is changed until you save them."
    ];
    for (const pattern of [ZYRA_RU_AFFIRMATIVE, ZYRA_RU_RESUME, ZYRA_RU_OFFER, ZYRA_RU_STAGED_AWAITING, ZYRA_RU_COMPLETION_CLAIM]) {
      for (const text of english) expect(test(pattern, text)).toBe(false);
    }
  });
});
