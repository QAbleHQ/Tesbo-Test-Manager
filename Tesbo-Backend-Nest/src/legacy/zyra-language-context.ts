import { AsyncLocalStorage } from "async_hooks";
import type { ExportLocale } from "../common/export-i18n";

/*
 * The language of the Zyra chat work currently running, for the many reply builders that have no
 * session in scope (zyraTimedOutDecision, zyraFailureReply, reconcileZyraReply, ...). Threading a
 * parameter through every one of them and every call site would touch dozens of signatures; instead
 * the three places Zyra chat work starts — runZyraChatTurn, processZyraChatResume and
 * continueZyraChatPlan — run their body inside the session's language, and the builders read it.
 *
 * Same mechanism as RequestCacheService. Outside such a run there is no store and the answer is
 * "en": every path that is not a Zyra chat turn, and every English session, is unchanged.
 */
const store = new AsyncLocalStorage<ExportLocale>();

export function runInZyraLanguage<T>(language: ExportLocale, fn: () => T): T {
  return store.run(language, fn);
}

export function zyraReplyLanguage(): ExportLocale {
  return store.getStore() ?? "en";
}
