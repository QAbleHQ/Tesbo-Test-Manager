// UI labels for the Zyra screens (chat, review panel, citations, task quick view / detail) in
// English and Russian.
//
// - The language is never guessed in the browser: it comes from the Zyra chat session or Zyra task
//   (`language: "en" | "ru"`), which the backend sets from the Unicode script of what the user typed
//   (Cyrillic -> Russian). Anything missing or unknown renders as English.
// - The Russian dictionary is typed against the English one (`Record<ZyraTextKey, Entry>`), so a key
//   added in English without a Russian translation is a type error, not a silently English label.
// - Translation is display-only. Values sent back to the API (a select's option value, a severity,
//   a status) always stay the English value; only the visible label changes. The data-value
//   vocabularies below match the backend's export table (Tesbo-Backend-Nest/src/common/export-i18n.ts).
// - English strings are kept byte-for-byte identical to the literals they replaced — e2e tests
//   assert on them.

import { createContext, useContext } from "react";

export type ZyraLanguage = "en" | "ru";

export function zyraLanguage(value: unknown): ZyraLanguage {
  return value === "ru" ? "ru" : "en";
}

type Params = Record<string, string | number>;
type Entry = string | ((p: Params) => string);

const s = (n: string | number) => (Number(n) === 1 ? "" : "s");

/** Russian plural form: 1 тест-кейс, 2 тест-кейса, 5 тест-кейсов. */
export function ruPlural(n: string | number, one: string, few: string, many: string): string {
  const abs = Math.abs(Number(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const EN = {
  // ── Shared ──────────────────────────────────────────────────────────────────
  copy: "Copy",
  copied: "Copied",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  savingDots: "Saving...",
  close: "Close",
  edit: "Edit",
  you: "You",

  // ── Column headers / field labels ───────────────────────────────────────────
  "col.id": "ID",
  "col.title": "Title",
  "col.priority": "Priority",
  "col.status": "Status",
  "col.firstStep": "First step",
  "col.source": "Source",
  "col.action": "Action",
  "col.severity": "Severity",
  "col.component": "Component",
  "col.preconditions": "Preconditions",
  "col.expectedResult": "Expected result",
  "col.expectedResultCap": "Expected Result",
  "col.description": "Description",
  "col.testData": "Test Data",
  "col.steps": "Steps",
  "col.tags": "Tags",
  "col.testcase": "Testcase",
  "col.actions": "Actions",

  // ── Chat: quick actions (label + the prompt it puts in the composer) ─────────
  "quick.smoke.label": "Generate smoke tests",
  "quick.smoke.prompt": "Generate smoke test cases covering the most critical user flows in this project.",
  "quick.gaps.label": "Find coverage gaps",
  "quick.gaps.prompt": "Analyze existing test cases and identify the most important areas of missing coverage.",
  "quick.negative.label": "Add negative scenarios",
  "quick.negative.prompt": "Add negative test cases for the main features, focusing on invalid inputs and error states.",
  "quick.expected.label": "Improve expected results",
  "quick.expected.prompt": "Review existing test cases and rewrite any weak or vague expected results to be more specific.",
  "quick.regression.label": "Regression test cases",
  "quick.regression.prompt": "Generate a regression test suite that covers the core product functionality.",
  "quick.review.label": "Review this module",
  "quick.review.prompt": "Review all test cases in this project and identify duplicates, outdated cases, and weak coverage.",
  "quick.edge.label": "Edge cases",
  "quick.edge.prompt": "Create edge case test scenarios covering boundary values, empty states, and unexpected inputs.",
  "quick.api.label": "API test cases",
  "quick.api.prompt": "Generate API test cases for the main endpoints covering success, error, and boundary scenarios.",

  // ── Chat: message meta + testcase table ─────────────────────────────────────
  "tc.summary.drafted": (p) => `${p.n} test case${s(p.n)} drafted for review`,
  "tc.summary.generated": (p) => `${p.n} test case${s(p.n)} generated`,
  "tc.summary.updated": (p) => `${p.n} test case${s(p.n)} updated`,
  "tc.summary.archived": (p) => `${p.n} test case${s(p.n)} archived`,
  "tc.summary.suggested": (p) => `${p.n} test case${s(p.n)} suggested`,
  "tc.count": (p) => `${p.n} test case${s(p.n)}`,
  "tc.copyTitle": "Copy these test cases as tab-separated values, ready to paste into Excel.",
  "source.created": "created",
  "source.updated": "updated",
  "source.archived": "archived",
  "source.suggested": "suggested",
  "source.aiChat": "AI · Zyra chat",

  // ── Chat: message bubble ────────────────────────────────────────────────────
  "msg.reasoning": "Zyra reasoning",
  "msg.noStructured":
    "⚠️ Zyra didn't return structured data for this reply — nothing above should be treated as saved or staged. Try asking again.",
  "msg.viewTestCases": "View test cases",
  "msg.continue": "Continue",
  "msg.timedOutRepeatedly": (p) =>
    `This has timed out ${p.n} times in a row. The batch may be too large for the provider to finish in time.`,
  "msg.continueSmaller": "Continue with a smaller batch (5 cases)",
  "msg.tryOriginal": "Try the original size again anyway",

  // ── Chat: progress trace — stage labels ─────────────────────────────────────
  "stage.received": "Received your request",
  "stage.resuming": "Resuming the timed-out request",
  "stage.retrying": "Re-reading your confirmation",
  "stage.plan:superseded": "Stopped the running generation plan",
  "stage.plan:batch": "Next batch of the generation plan",
  "stage.plan:stop": "Stopped the generation plan",
  "stage.plan:resume": "Resumed the generation plan",
  "stage.context:knowledge": "Knowledge Base",
  "stage.context:jira": "Jira",
  "stage.context:testcases": "Existing Test Cases",
  "stage.context:bugs": "Bugs",
  "stage.routing": "Deciding what to do",
  "stage.tool:jira_coverage": "Checking Jira test case coverage",
  "stage.summarizing": "Summarizing the result",
  "stage.generating": "Generating your test cases",
  "stage.drafting:updates": "Drafting the updates",
  "stage.staging": "Staging results",
  "stage.finalizing": "Finalizing",

  // ── Chat: progress trace — router decision labels ───────────────────────────
  "act.answer": "answer",
  "act.list": "list test cases",
  "act.create": "create test cases",
  "act.update": "update test cases",
  "act.archive": "archive test cases",
  "act.suite": "suite changes",
  "act.mixed": "several changes",
  "act.jira_pending_testcases": "Jira coverage",

  // ── Chat: progress trace — step summaries ───────────────────────────────────
  "sum.timedOutAfter": (p) => `timed out after ${p.d}`,
  "sum.timedOut": "timed out",
  "sum.skipped": (p) => `skipped: ${p.reason}`,
  "sum.disabled": "disabled",
  "sum.noneFound": "none found",
  "sum.found": (p) => `${p.n} found`,
  "sum.opCount": (p) => `${p.n} ${p.op}`,
  "op.create": "create",
  "op.update": "update",
  "op.archive": "archive",
  "sum.nothingToStage": "nothing to stage",
  "sum.saved": (p) => `${p.n} saved`,
  "sum.proposed": (p) => `${p.n} proposed for review`,
  "sum.nothingChanged": "nothing changed",
  "sum.contextItems": (p) => `${p.n} context items`,
  "sum.attempts": (p) => `${p.n} attempts`,
  "sum.drafted": (p) => `${p.n} drafted`,
  "sum.draftedOf": (p) => `${p.n} drafted of ${p.r} requested`,
  "sum.requested": (p) => `${p.n} requested`,
  "sum.intoSuite": (p) => ` into "${p.name}"`,
  "sum.smallerRetry": " · smaller retry",
  "sum.scenarios": (p) => `scenarios ${p.from}–${p.to}`,
  "sum.ofTotal": (p) => ` of ${p.n}`,
  "sum.retried": (p) => ` · ${p.n} retried`,
  "sum.scenariosCovered": (p) => `${p.done}/${p.total} scenarios covered`,
  "sum.attempt": (p) => `attempt ${p.n}`,
  "sum.actedOnIt": "acted on it",
  "sum.nothingToActOn": "still nothing to act on",
  "trace.interrupted": "interrupted — this request stopped before it finished",
  "trace.rowAttempt": (p) => ` · attempt ${p.n}`,
  "trace.more": (p) => `+${p.n} more`,
  "trace.steps": (p) => `${p.n} ${Number(p.n) === 1 ? "step" : "steps"}`,
  "trace.working": (p) => `zyra is working on this · ${p.d} elapsed`,
  "trace.header": (p) => `zyra · step ${p.n} · ${p.d}`,
  "trace.gathering": (p) => `# gathering context · ${p.d}`,
  "dur.minutes": (p) => `${p.m}m${p.s}s`,
  "dur.seconds": (p) => `${p.s}s`,

  // ── Chat: plan ──────────────────────────────────────────────────────────────
  "plan.generating": (p) =>
    `Generating remaining scenarios — ${p.covered}/${p.total} covered (${p.pct}%). Review what's in so far; more will appear here shortly.`,
  "plan.paused": (p) => `Paused — ${p.covered}/${p.total} scenarios covered.`,
  "plan.resuming": "Resuming…",
  "plan.resume": "Resume",
  "plan.stopping": "Stopping…",
  "plan.stop": "Stop",

  // ── Chat: rename / delete conversation ──────────────────────────────────────
  "rename.required": "Conversation name is required",
  "rename.failed": "Failed to rename conversation.",
  "rename.title": "Rename conversation",
  "rename.label": "Conversation name",
  "delete.title": "Delete conversation",
  "delete.message": (p) => `Delete "${p.title}"? This permanently removes its message history and cannot be undone.`,
  "delete.thisConversation": "this conversation",
  "delete.confirm": "Delete",

  // ── Chat: no AI key ─────────────────────────────────────────────────────────
  "nokey.title": "AI provider not connected",
  "nokey.body": "Zyra needs an Anthropic or OpenAI key allocated to this project before it can respond.",
  "nokey.setup": "Set up AI key",
  "nokey.settings": "Check Zyra settings",

  // ── Chat: error fallbacks (an API error's own message is shown as-is) ───────
  "err.deleteConversation": "Failed to delete conversation.",
  "err.load": "Failed to load Zyra chat.",
  "err.answer": "Zyra could not answer.",
  "err.slow": "Zyra is taking longer than expected. The reply will appear here once it's ready — refresh to check.",
  "err.failed": "Zyra couldn't finish answering that message. Please try again.",
  "err.resumeTurn": "Could not resume that turn. Try again.",
  "err.stop": "Failed to stop Zyra.",
  "err.resumePlan": "Failed to resume Zyra.",

  // ── Chat: page chrome ───────────────────────────────────────────────────────
  "top.aiConnected": "AI connected",
  "top.noAiKey": "No AI key",
  "top.taskBoard": "Task board",
  "top.settings": "Settings",
  "page.subtitle": "AI test case assistant — generate, update, and manage test cases through conversation.",
  "page.loading": "Loading Zyra…",
  "side.conversations": "Conversations",
  "side.sessions": (p) => `${p.n} ${Number(p.n) === 1 ? "session" : "sessions"}`,
  "side.new": "New",
  "side.empty": "No conversations yet",
  "chat.defaultModel": "default model",
  "chat.noKey": "No AI key connected",
  "empty.title": "How can I help?",
  "empty.body":
    "Generate test cases, find coverage gaps, update existing tests, or review your test suite — all through conversation.",
  "empty.quickActions": "Quick actions",
  "chat.catchUp": "catch up",
  "composer.placeholder": "Ask Zyra to generate, update, or review test cases...",
  "composer.placeholderNoKey": "Connect an AI key to start chatting with Zyra",
  // Rendered right after the <kbd>Enter</kbd> / <kbd>Shift+Enter</kbd> key caps.
  "composer.sendHint": " send",
  "composer.newLineHint": " new line",
  "composer.thinking": "Thinking...",
  "composer.send": "Send",

  // ── Review panel ────────────────────────────────────────────────────────────
  "review.checking": "Checking review status…",
  "review.resolved": "This batch was already saved or closed — nothing left here to review.",
  "review.err.discard": "Failed to discard the draft.",
  "review.err.saveEdit": "Failed to save the edit.",
  "review.savedMsg": (p) => `${p.n} test case${s(p.n)} saved to the repository.`,
  "review.err.save": "Failed to save the selected test cases.",
  "review.closedMsg": "Batch closed — nothing was saved to the repository.",
  "review.err.close": "Failed to close the batch.",
  "review.selected": (p) => `${p.selected} of ${p.total} selected — pending review`,
  "review.unselectAll": "Unselect all",
  "review.selectAll": "Select all",
  "review.copyTitle": "Copy these proposed test cases as tab-separated values, ready to paste into Excel.",
  "review.discardAll": "Discard all",
  // `n` is the selected count, or "" when nothing is selected (kept as the original rendered it).
  "review.saveToRepo": (p) => `Save ${p.n} to repository`,
  "review.listLabel": "Proposed test cases",
  "review.selectRow": (p) => `Select proposed test case ${p.n}`,
  "review.proposed": "Proposed",
  "review.discard": "Discard",
  "draftAction.proposed-create": "New",
  "draftAction.proposed-update": "Update",
  "draftAction.proposed-archive": "Archive",
  "tech.equivalence_partitioning": "Equivalence Partitioning",
  "tech.boundary_value_analysis": "Boundary Value Analysis",
  "tech.decision_table": "Decision Table",
  "tech.state_testing": "State Testing",
  "tech.use_case_testing": "Use Case Testing",
  "tech.pairwise_testing": "Pairwise Testing",
  "tech.error_guessing": "Error Guessing",
  "tech.security_perspective": "Security Perspective",

  // ── Draft editor ────────────────────────────────────────────────────────────
  "editor.select": "Select",
  "editor.componentPlaceholder": "e.g. Checkout",
  "editor.testDataPlaceholder": "Input data, sample values, or setup-specific data",
  "editor.stepAction": (p) => `Step ${p.n} action`,
  "editor.remove": "Remove",
  "editor.addStep": "+ Add step",
  "editor.saveEdit": "Save edit",

  // ── Citations ───────────────────────────────────────────────────────────────
  "cite.type.knowledge_document": "Knowledge base",
  "cite.type.knowledge_file": "Knowledge base",
  "cite.type.jira_ticket": "Jira",
  "cite.type.testcase": "Test case",
  "cite.type.bug": "Bug",
  "cite.none": "No specific source cited",
  "cite.used": (p) => `Context used (${p.n})`,
  "cite.hide": "Hide context",

  // ── Context drawer ──────────────────────────────────────────────────────────
  "doctype.general": "General",
  "doctype.api_note": "API Note",
  "doctype.release_note": "Release Note",
  "doctype.requirement_note": "Requirement",
  "doctype.test_data_note": "Test Data",
  "drawer.description": "Description",
  "drawer.testData": "Test data",
  "drawer.expectedPrefix": "Expected: ",
  "drawer.postconditions": "Postconditions",
  "drawer.notes": "Notes",
  "drawer.customFields": "Custom fields",
  "drawer.reportedBy": "Reported by: ",
  "drawer.assignedTo": "Assigned to: ",
  "drawer.created": "Created: ",
  "drawer.evidence": "Evidence",
  "drawer.kb": "KB",
  "drawer.openInTracker": "Open in tracker",
  "drawer.noText": "This document has no text content yet.",
  "drawer.syncedFrom": (p) => `Synced from ${p.provider}`,
  "drawer.syncedBy": (p) => ` by ${p.name}`,
  "drawer.syncedOn": (p) => ` on ${p.date}`,
  "drawer.reviewedOn": "Reviewed on ",
  "drawer.openFull": "Open full page",
  "drawer.type": "Type: ",
  "drawer.unknown": "Unknown",
  "drawer.size": "Size: ",
  "drawer.uploaded": "Uploaded: ",
  "drawer.download": "Download",
  "drawer.reporter": "Reporter: ",
  "drawer.assignee": "Assignee: ",
  "drawer.labels": "Labels: ",
  "drawer.updated": "Updated: ",
  "drawer.openInJira": "Open in Jira",
  "drawer.stale.testcase": "This test case is no longer available — it looks like it was deleted after Zyra cited it here.",
  "drawer.stale.bug": "This bug is no longer available — it looks like it was deleted after Zyra cited it here.",
  "drawer.stale.knowledge_document":
    "This knowledge base document is no longer available — it may have been deleted, or its source (e.g. a connected Jira sync) may have been disconnected, since Zyra cited it here.",
  "drawer.stale.knowledge_file":
    "This knowledge base file is no longer available — it looks like it was deleted after Zyra cited it here.",
  "drawer.stale.jira_ticket":
    "This Jira ticket could not be found — it may have been unlinked or removed from the sync since Zyra cited it here.",
  "drawer.typeTitle.knowledge_document": "Knowledge base document",
  "drawer.typeTitle.knowledge_file": "Knowledge base file",
  "drawer.typeTitle.jira_ticket": "Jira ticket",
  "drawer.typeTitle.testcase": "Test case",
  "drawer.typeTitle.bug": "Bug",
  "drawer.loading": "Loading…",
  "drawer.failedLoad": "Failed to load this item.",

  // ── Task quick view + task detail ───────────────────────────────────────────
  "taskStatus.todo": "Pending",
  "taskStatus.in_progress": "In Progress",
  "taskStatus.in_review": "In Review",
  "taskStatus.failed": "Failed",
  "taskStatus.done": "Done",
  "task.failedDefault": "Zyra failed to generate testcase drafts.",
  "task.err.close": "Failed to close task.",
  "task.tab.testcases": "Test cases",
  "task.tab.generated": "Generated Testcases",
  "task.tab.feedback": "Feedback",
  "task.tab.sources": "Sources",
  "task.tab.activity": "Activity",
  "task.tab.activities": "Activities",
  "task.stat.testcases": "Test cases",
  "task.stat.tokens": "Tokens used",
  "task.stat.approval": "Approval rate",
  "task.copyAllTitle": "Copy every generated testcase as tab-separated values, ready to paste into Excel.",
  "task.copySelectedTitle": "Copy the selected testcases as tab-separated values, ready to paste into Excel.",
  "task.copyAll": "Copy all",
  "task.copySelected": (p) => `Copy ${p.n} selected`,
  "task.noDrafts": "No generated testcases remain for this task.",
  "task.noFeedback": "No feedback yet.",
  "task.noSources": "No source summary recorded.",
  "task.noActivity": "No activity recorded yet.",
  "task.viewFull": "View full task",
  "task.closing": "Closing…",
  "task.closeTask": "Close task",
  "task.commentStatus.pending": "Posting…",
  "task.commentStatus.posted": "Posted",
  "task.commentStatus.failed": "Failed",
  "task.commentStatus.skipped_disabled": "Not posted — auto-comment off",
  "task.commentStatus.skipped_not_connected": "Not posted — not connected",
  "task.err.load": "Failed to load task.",
  "task.commentPosted": (p) => `Comment posted on ${p.label} ${p.key}.`,
  // `reason` is "" when the API gave none.
  "task.commentStillFailed": (p) => `Comment still couldn't be posted on ${p.label} ${p.key}${p.reason ? `: ${p.reason}` : "."}`,
  "task.err.retryComment": "Failed to retry the ticket comment.",
  "task.feedbackSent":
    "Feedback sent. Zyra moved the task to Todo and is regenerating the testcase drafts now — this can take a minute.",
  "task.err.feedback": "Failed to send feedback.",
  "task.draftDeleted": "Generated testcase draft deleted.",
  "task.err.deleteDraft": "Failed to delete testcase draft.",
  "task.draftsDeleted": (p) => `${p.n} generated testcase draft${s(p.n)} deleted.`,
  "task.err.deleteDrafts": "Failed to delete selected testcase drafts.",
  "task.saved": (p) => `${p.n} testcase${s(p.n)} saved.`,
  "task.err.save": "Failed to save testcases.",
  "task.closed": "Task closed.",
  "task.pageTitle": "Zyra task",
  "task.loading": "Loading task…",
  "task.subtitle": "Review the task, save or remove generated testcases, provide feedback, and track every Zyra status update.",
  "task.backToBoard": "Back to board",
  "task.summary": (p) =>
    `${p.generated} testcase${s(p.generated)} generated, ${p.saved} saved, ${p.tokens} tokens, updated ${p.date}`,
  "task.noDescription": "No description available",
  "task.viewMore": "View more",
  "task.viewLess": "View less",
  "task.ticketComments": "Ticket comments",
  "task.ticketCommentsHint":
    "What was posted to the linked ticket after each save. A failed comment can be sent again once the cause is fixed.",
  "task.commentCount": (p) => `${p.n} testcase${s(p.n)}`,
  "task.retrying": "Retrying...",
  "task.retryComment": "Retry comment",
  // Rendered right after the bold selected count.
  "task.selectedOf": (p) => ` of ${p.n} testcase${s(p.n)} selected`,
  "task.clearSelection": "Clear selection",
  "task.saveSelected": "Save selected",
  "task.deleteSelected": "Delete selected",
  "task.selectAllAria": "Select all generated testcases",
  "task.selectRow": (p) => `Select testcase ${p.n}`,
  "task.stepCount": (p) => `${p.n} step${s(p.n)}`,
  "task.delete": "Delete",
  "task.sendFeedbackTitle": "Send feedback",
  "task.sendFeedbackHint":
    "Send updates from the same review table so Zyra can regenerate this task with the latest context.",
  "task.feedbackLabel": "Feedback for Zyra",
  "task.feedbackPlaceholder":
    "Ask Zyra to improve coverage, add edge cases, remove duplicates, or focus on a missed rule.",
  "task.refsLabel": "Docs or ticket references for knowledge base",
  "task.refsPlaceholder": "Mention docs, Jira or Linear tickets, Notion pages, release notes, or policy links Zyra should consider.",
  "task.attachJira": "Attach Jira tickets",
  "task.attachLinear": "Attach Linear tickets",
  "task.attachNotion": "Attach Notion pages",
  "task.selectTicket": "Select ticket...",
  "task.feedbackLocked": "Feedback opens up once Zyra finishes generating drafts for this task.",
  "task.feedbackClosed": "Feedback isn't available once a task is closed.",
  "task.sending": "Sending...",
  "task.sendFeedback": "Send feedback",
  "task.saveModal.title": "Save generated testcases",
  "task.saveModal.body": (p) => `Save ${p.n} selected testcase draft(s).`,
  "task.suiteTarget": "Suite target",
  "task.selectSuite": "Select suite",
  "task.noSuite": "No suite",
  "task.existingSuite": "Existing suite",
  "task.createSuite": "Create new suite",
  "task.selectExistingSuite": "Select existing suite",
  "task.selectASuite": "Select a suite",
  "task.noSuitesHint": "This project has no suites yet — choose Create new suite instead.",
  "task.newSuiteName": "New suite name",
  "task.newSuitePlaceholder": "AI generated regression",
} satisfies Record<string, Entry>;

export type ZyraTextKey = keyof typeof EN;

const tc = (n: string | number) => ruPlural(n, "тест-кейс", "тест-кейса", "тест-кейсов");

const RU: Record<ZyraTextKey, Entry> = {
  copy: "Копировать",
  copied: "Скопировано",
  cancel: "Отмена",
  save: "Сохранить",
  saving: "Сохранение…",
  savingDots: "Сохранение...",
  close: "Закрыть",
  edit: "Изменить",
  you: "Вы",

  "col.id": "ID",
  "col.title": "Название",
  "col.priority": "Приоритет",
  "col.status": "Статус",
  "col.firstStep": "Первый шаг",
  "col.source": "Источник",
  "col.action": "Действие",
  "col.severity": "Серьёзность",
  "col.component": "Компонент",
  "col.preconditions": "Предусловия",
  "col.expectedResult": "Ожидаемый результат",
  "col.expectedResultCap": "Ожидаемый результат",
  "col.description": "Описание",
  "col.testData": "Тестовые данные",
  "col.steps": "Шаги",
  "col.tags": "Теги",
  "col.testcase": "Тест-кейс",
  "col.actions": "Действия",

  "quick.smoke.label": "Сгенерировать смоук-тесты",
  "quick.smoke.prompt": "Сгенерируй смоук-тест-кейсы, покрывающие самые критичные пользовательские сценарии этого проекта.",
  "quick.gaps.label": "Найти пробелы в покрытии",
  "quick.gaps.prompt": "Проанализируй существующие тест-кейсы и найди самые важные области, где не хватает покрытия.",
  "quick.negative.label": "Добавить негативные сценарии",
  "quick.negative.prompt": "Добавь негативные тест-кейсы для основных функций с упором на некорректный ввод и состояния ошибок.",
  "quick.expected.label": "Улучшить ожидаемые результаты",
  "quick.expected.prompt": "Проверь существующие тест-кейсы и перепиши слабые или размытые ожидаемые результаты, сделав их конкретнее.",
  "quick.regression.label": "Регрессионные тест-кейсы",
  "quick.regression.prompt": "Сгенерируй набор регрессионных тестов, покрывающий основную функциональность продукта.",
  "quick.review.label": "Проверить этот модуль",
  "quick.review.prompt": "Проверь все тест-кейсы этого проекта и найди дубликаты, устаревшие тест-кейсы и слабое покрытие.",
  "quick.edge.label": "Граничные случаи",
  "quick.edge.prompt": "Создай тестовые сценарии для граничных случаев: граничные значения, пустые состояния и неожиданный ввод.",
  "quick.api.label": "Тест-кейсы для API",
  "quick.api.prompt": "Сгенерируй тест-кейсы для основных эндпоинтов API, покрывающие успешные, ошибочные и граничные сценарии.",

  "tc.summary.drafted": (p) => `Черновики на проверку: ${p.n}`,
  "tc.summary.generated": (p) => `Создано тест-кейсов: ${p.n}`,
  "tc.summary.updated": (p) => `Обновлено тест-кейсов: ${p.n}`,
  "tc.summary.archived": (p) => `Архивировано тест-кейсов: ${p.n}`,
  "tc.summary.suggested": (p) => `Предложено тест-кейсов: ${p.n}`,
  "tc.count": (p) => `${p.n} ${tc(p.n)}`,
  "tc.copyTitle": "Скопировать эти тест-кейсы в формате TSV (через табуляцию) для вставки в Excel.",
  "source.created": "создан",
  "source.updated": "обновлён",
  "source.archived": "архивирован",
  "source.suggested": "предложен",
  "source.aiChat": "ИИ · чат Zyra",

  "msg.reasoning": "Ход рассуждений Zyra",
  "msg.noStructured":
    "⚠️ Zyra не вернула структурированные данные для этого ответа — ничего из показанного выше не сохранено и не подготовлено к проверке. Попробуйте спросить ещё раз.",
  "msg.viewTestCases": "Открыть тест-кейсы",
  "msg.continue": "Продолжить",
  "msg.timedOutRepeatedly": (p) =>
    `Время ожидания истекло ${p.n} ${ruPlural(p.n, "раз", "раза", "раз")} подряд. Возможно, пакет слишком велик, чтобы провайдер успел его обработать.`,
  "msg.continueSmaller": "Продолжить с пакетом поменьше (5 тест-кейсов)",
  "msg.tryOriginal": "Всё равно повторить с исходным размером",

  "stage.received": "Получили ваш запрос",
  "stage.resuming": "Возобновляем запрос, превысивший время ожидания",
  "stage.retrying": "Перечитываем ваше подтверждение",
  "stage.plan:superseded": "Остановлен текущий план генерации",
  "stage.plan:batch": "Следующий пакет плана генерации",
  "stage.plan:stop": "План генерации остановлен",
  "stage.plan:resume": "План генерации возобновлён",
  "stage.context:knowledge": "База знаний",
  "stage.context:jira": "Jira",
  "stage.context:testcases": "Существующие тест-кейсы",
  "stage.context:bugs": "Баги",
  "stage.routing": "Решаем, что сделать",
  "stage.tool:jira_coverage": "Проверяем покрытие задач Jira тест-кейсами",
  "stage.summarizing": "Подводим итог",
  "stage.generating": "Генерируем тест-кейсы",
  "stage.drafting:updates": "Готовим изменения",
  "stage.staging": "Подготавливаем результаты",
  "stage.finalizing": "Завершаем",

  "act.answer": "ответ",
  "act.list": "список тест-кейсов",
  "act.create": "создание тест-кейсов",
  "act.update": "обновление тест-кейсов",
  "act.archive": "архивация тест-кейсов",
  "act.suite": "изменения наборов",
  "act.mixed": "несколько изменений",
  "act.jira_pending_testcases": "покрытие Jira",

  "sum.timedOutAfter": (p) => `время ожидания истекло через ${p.d}`,
  "sum.timedOut": "время ожидания истекло",
  "sum.skipped": (p) => `пропущено: ${p.reason}`,
  "sum.disabled": "отключено",
  "sum.noneFound": "ничего не найдено",
  "sum.found": (p) => `найдено: ${p.n}`,
  "sum.opCount": (p) => `${p.op}: ${p.n}`,
  "op.create": "создание",
  "op.update": "обновление",
  "op.archive": "архивация",
  "sum.nothingToStage": "нечего подготавливать",
  "sum.saved": (p) => `сохранено: ${p.n}`,
  "sum.proposed": (p) => `на проверку: ${p.n}`,
  "sum.nothingChanged": "ничего не изменилось",
  "sum.contextItems": (p) => `элементов контекста: ${p.n}`,
  "sum.attempts": (p) => `попыток: ${p.n}`,
  "sum.drafted": (p) => `подготовлено: ${p.n}`,
  "sum.draftedOf": (p) => `подготовлено ${p.n} из ${p.r} запрошенных`,
  "sum.requested": (p) => `запрошено: ${p.n}`,
  "sum.intoSuite": (p) => ` в набор «${p.name}»`,
  "sum.smallerRetry": " · повтор с пакетом поменьше",
  "sum.scenarios": (p) => `сценарии ${p.from}–${p.to}`,
  "sum.ofTotal": (p) => ` из ${p.n}`,
  "sum.retried": (p) => ` · повторено: ${p.n}`,
  "sum.scenariosCovered": (p) => `покрыто сценариев: ${p.done}/${p.total}`,
  "sum.attempt": (p) => `попытка ${p.n}`,
  "sum.actedOnIt": "выполнено",
  "sum.nothingToActOn": "по-прежнему нечего выполнять",
  "trace.interrupted": "прервано — запрос остановился, не завершившись",
  "trace.rowAttempt": (p) => ` · попытка ${p.n}`,
  "trace.more": (p) => `и ещё ${p.n}`,
  "trace.steps": (p) => `${p.n} ${ruPlural(p.n, "шаг", "шага", "шагов")}`,
  "trace.working": (p) => `zyra работает над запросом · прошло ${p.d}`,
  "trace.header": (p) => `zyra · шаг ${p.n} · ${p.d}`,
  "trace.gathering": (p) => `# сбор контекста · ${p.d}`,
  "dur.minutes": (p) => `${p.m}м${p.s}с`,
  "dur.seconds": (p) => `${p.s}с`,

  "plan.generating": (p) =>
    `Генерируем оставшиеся сценарии — покрыто ${p.covered}/${p.total} (${p.pct}%). Проверьте то, что уже готово; остальное скоро появится здесь.`,
  "plan.paused": (p) => `Приостановлено — покрыто сценариев: ${p.covered}/${p.total}.`,
  "plan.resuming": "Возобновление…",
  "plan.resume": "Возобновить",
  "plan.stopping": "Остановка…",
  "plan.stop": "Остановить",

  "rename.required": "Укажите название беседы",
  "rename.failed": "Не удалось переименовать беседу.",
  "rename.title": "Переименовать беседу",
  "rename.label": "Название беседы",
  "delete.title": "Удалить беседу",
  "delete.message": (p) => `Удалить «${p.title}»? История сообщений будет удалена безвозвратно, это действие нельзя отменить.`,
  "delete.thisConversation": "эту беседу",
  "delete.confirm": "Удалить",

  "nokey.title": "ИИ-провайдер не подключён",
  "nokey.body": "Чтобы Zyra могла отвечать, назначьте этому проекту ключ Anthropic или OpenAI.",
  "nokey.setup": "Настроить ключ ИИ",
  "nokey.settings": "Проверить настройки Zyra",

  "err.deleteConversation": "Не удалось удалить беседу.",
  "err.load": "Не удалось загрузить чат Zyra.",
  "err.answer": "Zyra не смогла ответить.",
  "err.slow": "Zyra отвечает дольше обычного. Ответ появится здесь, как только будет готов, — обновите страницу, чтобы проверить.",
  "err.failed": "Zyra не смогла закончить ответ на это сообщение. Попробуйте ещё раз.",
  "err.resumeTurn": "Не удалось возобновить этот запрос. Попробуйте ещё раз.",
  "err.stop": "Не удалось остановить Zyra.",
  "err.resumePlan": "Не удалось возобновить работу Zyra.",

  "top.aiConnected": "ИИ подключён",
  "top.noAiKey": "Нет ключа ИИ",
  "top.taskBoard": "Доска задач",
  "top.settings": "Настройки",
  "page.subtitle": "ИИ-ассистент по тест-кейсам — создавайте, обновляйте и ведите тест-кейсы в формате диалога.",
  "page.loading": "Загрузка Zyra…",
  "side.conversations": "Беседы",
  "side.sessions": (p) => `${p.n} ${ruPlural(p.n, "беседа", "беседы", "бесед")}`,
  "side.new": "Новая",
  "side.empty": "Бесед пока нет",
  "chat.defaultModel": "модель по умолчанию",
  "chat.noKey": "Ключ ИИ не подключён",
  "empty.title": "Чем могу помочь?",
  "empty.body":
    "Создавайте тест-кейсы, находите пробелы в покрытии, обновляйте существующие тесты или проверяйте набор тестов — всё в формате диалога.",
  "empty.quickActions": "Быстрые действия",
  "chat.catchUp": "к новым сообщениям",
  "composer.placeholder": "Попросите Zyra создать, обновить или проверить тест-кейсы...",
  "composer.placeholderNoKey": "Подключите ключ ИИ, чтобы начать общение с Zyra",
  "composer.sendHint": " — отправить",
  "composer.newLineHint": " — новая строка",
  "composer.thinking": "Думаю...",
  "composer.send": "Отправить",

  "review.checking": "Проверяем состояние пакета…",
  "review.resolved": "Этот пакет уже сохранён или закрыт — проверять здесь больше нечего.",
  "review.err.discard": "Не удалось отклонить черновик.",
  "review.err.saveEdit": "Не удалось сохранить изменения.",
  "review.savedMsg": (p) => `Сохранено в репозиторий: ${p.n} ${tc(p.n)}.`,
  "review.err.save": "Не удалось сохранить выбранные тест-кейсы.",
  "review.closedMsg": "Пакет закрыт — в репозиторий ничего не сохранено.",
  "review.err.close": "Не удалось закрыть пакет.",
  "review.selected": (p) => `Выбрано ${p.selected} из ${p.total} — ожидает проверки`,
  "review.unselectAll": "Снять выбор",
  "review.selectAll": "Выбрать все",
  "review.copyTitle": "Скопировать предложенные тест-кейсы в формате TSV (через табуляцию) для вставки в Excel.",
  "review.discardAll": "Отклонить все",
  "review.saveToRepo": (p) => (p.n === "" ? "Сохранить в репозиторий" : `Сохранить ${p.n} в репозиторий`),
  "review.listLabel": "Предложенные тест-кейсы",
  "review.selectRow": (p) => `Выбрать предложенный тест-кейс ${p.n}`,
  "review.proposed": "Предложено",
  "review.discard": "Отклонить",
  "draftAction.proposed-create": "Новый",
  "draftAction.proposed-update": "Изменение",
  "draftAction.proposed-archive": "Архивация",
  "tech.equivalence_partitioning": "Классы эквивалентности",
  "tech.boundary_value_analysis": "Анализ граничных значений",
  "tech.decision_table": "Таблица решений",
  "tech.state_testing": "Тестирование состояний",
  "tech.use_case_testing": "Тестирование по сценариям использования",
  "tech.pairwise_testing": "Попарное тестирование",
  "tech.error_guessing": "Предугадывание ошибок",
  "tech.security_perspective": "Проверка безопасности",

  "editor.select": "Выберите",
  "editor.componentPlaceholder": "например, Оформление заказа",
  "editor.testDataPlaceholder": "Входные данные, примеры значений или данные для настройки",
  "editor.stepAction": (p) => `Действие шага ${p.n}`,
  "editor.remove": "Удалить",
  "editor.addStep": "+ Добавить шаг",
  "editor.saveEdit": "Сохранить изменения",

  "cite.type.knowledge_document": "База знаний",
  "cite.type.knowledge_file": "База знаний",
  "cite.type.jira_ticket": "Jira",
  "cite.type.testcase": "Тест-кейс",
  "cite.type.bug": "Баг",
  "cite.none": "Конкретный источник не указан",
  "cite.used": (p) => `Использованный контекст (${p.n})`,
  "cite.hide": "Скрыть контекст",

  "doctype.general": "Общее",
  "doctype.api_note": "Заметка по API",
  "doctype.release_note": "Заметка о релизе",
  "doctype.requirement_note": "Требование",
  "doctype.test_data_note": "Тестовые данные",
  "drawer.description": "Описание",
  "drawer.testData": "Тестовые данные",
  "drawer.expectedPrefix": "Ожидается: ",
  "drawer.postconditions": "Постусловия",
  "drawer.notes": "Примечания",
  "drawer.customFields": "Пользовательские поля",
  "drawer.reportedBy": "Автор: ",
  "drawer.assignedTo": "Исполнитель: ",
  "drawer.created": "Создан: ",
  "drawer.evidence": "Вложения",
  "drawer.kb": "КБ",
  "drawer.openInTracker": "Открыть в трекере",
  "drawer.noText": "В этом документе пока нет текста.",
  "drawer.syncedFrom": (p) => `Синхронизировано из ${p.provider}`,
  "drawer.syncedBy": (p) => ` пользователем ${p.name}`,
  "drawer.syncedOn": (p) => ` ${p.date}`,
  "drawer.reviewedOn": "Проверено ",
  "drawer.openFull": "Открыть полностью",
  "drawer.type": "Тип: ",
  "drawer.unknown": "Неизвестно",
  "drawer.size": "Размер: ",
  "drawer.uploaded": "Загружен: ",
  "drawer.download": "Скачать",
  "drawer.reporter": "Автор: ",
  "drawer.assignee": "Исполнитель: ",
  "drawer.labels": "Метки: ",
  "drawer.updated": "Обновлено: ",
  "drawer.openInJira": "Открыть в Jira",
  "drawer.stale.testcase": "Этот тест-кейс больше недоступен — похоже, его удалили после того, как Zyra сослалась на него.",
  "drawer.stale.bug": "Этот баг больше недоступен — похоже, его удалили после того, как Zyra сослалась на него.",
  "drawer.stale.knowledge_document":
    "Этот документ базы знаний больше недоступен — возможно, его удалили или отключили его источник (например, синхронизацию с Jira) после того, как Zyra сослалась на него.",
  "drawer.stale.knowledge_file":
    "Этот файл базы знаний больше недоступен — похоже, его удалили после того, как Zyra сослалась на него.",
  "drawer.stale.jira_ticket":
    "Эта задача Jira не найдена — возможно, её отвязали или исключили из синхронизации после того, как Zyra сослалась на неё.",
  "drawer.typeTitle.knowledge_document": "Документ базы знаний",
  "drawer.typeTitle.knowledge_file": "Файл базы знаний",
  "drawer.typeTitle.jira_ticket": "Задача Jira",
  "drawer.typeTitle.testcase": "Тест-кейс",
  "drawer.typeTitle.bug": "Баг",
  "drawer.loading": "Загрузка…",
  "drawer.failedLoad": "Не удалось загрузить этот элемент.",

  "taskStatus.todo": "В ожидании",
  "taskStatus.in_progress": "В работе",
  "taskStatus.in_review": "На проверке",
  "taskStatus.failed": "Ошибка",
  "taskStatus.done": "Готово",
  "task.failedDefault": "Zyra не удалось сгенерировать черновики тест-кейсов.",
  "task.err.close": "Не удалось закрыть задачу.",
  "task.tab.testcases": "Тест-кейсы",
  "task.tab.generated": "Сгенерированные тест-кейсы",
  "task.tab.feedback": "Отзывы",
  "task.tab.sources": "Источники",
  "task.tab.activity": "Активность",
  "task.tab.activities": "Активность",
  "task.stat.testcases": "Тест-кейсы",
  "task.stat.tokens": "Использовано токенов",
  "task.stat.approval": "Доля одобренных",
  "task.copyAllTitle": "Скопировать все сгенерированные тест-кейсы в формате TSV (через табуляцию) для вставки в Excel.",
  "task.copySelectedTitle": "Скопировать выбранные тест-кейсы в формате TSV (через табуляцию) для вставки в Excel.",
  "task.copyAll": "Копировать все",
  "task.copySelected": (p) => `Копировать выбранные (${p.n})`,
  "task.noDrafts": "Для этой задачи не осталось сгенерированных тест-кейсов.",
  "task.noFeedback": "Отзывов пока нет.",
  "task.noSources": "Сведения об источниках не записаны.",
  "task.noActivity": "Активность пока не записана.",
  "task.viewFull": "Открыть задачу полностью",
  "task.closing": "Закрытие…",
  "task.closeTask": "Закрыть задачу",
  "task.commentStatus.pending": "Публикация…",
  "task.commentStatus.posted": "Опубликован",
  "task.commentStatus.failed": "Ошибка",
  "task.commentStatus.skipped_disabled": "Не опубликован — автокомментарии отключены",
  "task.commentStatus.skipped_not_connected": "Не опубликован — нет подключения",
  "task.err.load": "Не удалось загрузить задачу.",
  "task.commentPosted": (p) => `Комментарий опубликован в ${p.label} ${p.key}.`,
  "task.commentStillFailed": (p) =>
    `Комментарий по-прежнему не удалось опубликовать в ${p.label} ${p.key}${p.reason ? `: ${p.reason}` : "."}`,
  "task.err.retryComment": "Не удалось повторно отправить комментарий к задаче.",
  "task.feedbackSent":
    "Отзыв отправлен. Zyra вернула задачу в «К выполнению» и заново генерирует черновики тест-кейсов — это может занять около минуты.",
  "task.err.feedback": "Не удалось отправить отзыв.",
  "task.draftDeleted": "Сгенерированный черновик тест-кейса удалён.",
  "task.err.deleteDraft": "Не удалось удалить черновик тест-кейса.",
  "task.draftsDeleted": (p) => `Удалено черновиков тест-кейсов: ${p.n}.`,
  "task.err.deleteDrafts": "Не удалось удалить выбранные черновики тест-кейсов.",
  "task.saved": (p) => `Сохранено тест-кейсов: ${p.n}.`,
  "task.err.save": "Не удалось сохранить тест-кейсы.",
  "task.closed": "Задача закрыта.",
  "task.pageTitle": "Задача Zyra",
  "task.loading": "Загрузка задачи…",
  "task.subtitle":
    "Проверьте задачу, сохраните или удалите сгенерированные тест-кейсы, оставьте отзыв и отслеживайте все обновления статуса от Zyra.",
  "task.backToBoard": "Назад к доске",
  "task.summary": (p) =>
    `Сгенерировано тест-кейсов: ${p.generated}, сохранено: ${p.saved}, токенов: ${p.tokens}, обновлено ${p.date}`,
  "task.noDescription": "Описание отсутствует",
  "task.viewMore": "Показать больше",
  "task.viewLess": "Показать меньше",
  "task.ticketComments": "Комментарии в задачах трекера",
  "task.ticketCommentsHint":
    "Что публиковалось в связанной задаче после каждого сохранения. Неудавшийся комментарий можно отправить повторно, когда причина будет устранена.",
  "task.commentCount": (p) => `${p.n} ${tc(p.n)}`,
  "task.retrying": "Повтор...",
  "task.retryComment": "Отправить повторно",
  "task.selectedOf": (p) => ` из ${p.n} выбрано`,
  "task.clearSelection": "Сбросить выбор",
  "task.saveSelected": "Сохранить выбранные",
  "task.deleteSelected": "Удалить выбранные",
  "task.selectAllAria": "Выбрать все сгенерированные тест-кейсы",
  "task.selectRow": (p) => `Выбрать тест-кейс ${p.n}`,
  "task.stepCount": (p) => `${p.n} ${ruPlural(p.n, "шаг", "шага", "шагов")}`,
  "task.delete": "Удалить",
  "task.sendFeedbackTitle": "Отправить отзыв",
  "task.sendFeedbackHint":
    "Отправляйте уточнения прямо из этой таблицы проверки, чтобы Zyra заново сгенерировала задачу с учётом актуального контекста.",
  "task.feedbackLabel": "Отзыв для Zyra",
  "task.feedbackPlaceholder":
    "Попросите Zyra улучшить покрытие, добавить граничные случаи, убрать дубликаты или учесть пропущенное правило.",
  "task.refsLabel": "Ссылки на документы или задачи для базы знаний",
  "task.refsPlaceholder": "Укажите документы, задачи Jira или Linear, страницы Notion, заметки о релизе или ссылки на правила, которые Zyra должна учесть.",
  "task.attachJira": "Прикрепить задачи Jira",
  "task.attachLinear": "Прикрепить задачи Linear",
  "task.attachNotion": "Прикрепить страницы Notion",
  "task.selectTicket": "Выберите задачу...",
  "task.feedbackLocked": "Отзыв можно будет оставить, когда Zyra закончит генерацию черновиков для этой задачи.",
  "task.feedbackClosed": "Для закрытой задачи отзыв недоступен.",
  "task.sending": "Отправка...",
  "task.sendFeedback": "Отправить отзыв",
  "task.saveModal.title": "Сохранение сгенерированных тест-кейсов",
  "task.saveModal.body": (p) => `Сохранить выбранные черновики тест-кейсов: ${p.n}.`,
  "task.suiteTarget": "Целевой набор",
  "task.selectSuite": "Выберите набор",
  "task.noSuite": "Без набора",
  "task.existingSuite": "Существующий набор",
  "task.createSuite": "Создать новый набор",
  "task.selectExistingSuite": "Выберите существующий набор",
  "task.selectASuite": "Выберите набор",
  "task.noSuitesHint": "В этом проекте пока нет наборов — выберите «Создать новый набор».",
  "task.newSuiteName": "Название нового набора",
  "task.newSuitePlaceholder": "Регрессия, сгенерированная ИИ",
};

// ── Data-value vocabularies (display only) ────────────────────────────────────
// Exactly the Russian words of the backend export table (export-i18n.ts RU_VALUES). Priority
// (P0–P3) and the API/UI test types are the same in both languages. An unknown value passes through.
const RU_VALUES = {
  severity: { Critical: "Критическая", High: "Высокая", Medium: "Средняя", Low: "Низкая" },
  testcaseStatus: {
    Draft: "Черновик",
    "In Review": "На проверке",
    Approved: "Утверждён",
    Deprecated: "Устаревший",
    Archived: "В архиве",
  },
  type: {
    Functional: "Функциональный",
    Regression: "Регрессионный",
    Smoke: "Смоук",
    Sanity: "Санити",
    Integration: "Интеграционный",
    Performance: "Производительность",
    Security: "Безопасность",
  },
  automationStatus: {
    Automated: "Автоматизирован",
    "Not Automated": "Не автоматизирован",
    "Can't Automate": "Невозможно автоматизировать",
  },
} satisfies Record<string, Record<string, string>>;

export type ZyraValueField = keyof typeof RU_VALUES;

/** The display label for a stored value. Never use the result as a value sent back to the API. */
export function zyraValueLabel(lang: ZyraLanguage, field: ZyraValueField, value: string): string {
  if (lang !== "ru") return value;
  return (RU_VALUES[field] as Record<string, string>)[value] ?? value;
}

export type ZyraT = {
  (key: ZyraTextKey, params?: Params): string;
  lang: ZyraLanguage;
  /** Lookup for a key built from data (a stage name, an action); undefined when there is no such key. */
  opt: (key: string, params?: Params) => string | undefined;
  /** Display label for a data value — see zyraValueLabel. */
  value: (field: ZyraValueField, value: string) => string;
  /** Locale for Intl/toLocaleString: undefined (browser default, unchanged) for English. */
  locale: string | undefined;
};

function render(entry: Entry, params?: Params): string {
  return typeof entry === "function" ? entry(params ?? {}) : entry;
}

function makeT(lang: ZyraLanguage): ZyraT {
  const dict: Record<string, Entry> = lang === "ru" ? RU : EN;
  const t = ((key: ZyraTextKey, params?: Params) => render(dict[key], params)) as ZyraT;
  t.lang = lang;
  t.opt = (key, params) => (Object.prototype.hasOwnProperty.call(dict, key) ? render(dict[key], params) : undefined);
  t.value = (field, value) => zyraValueLabel(lang, field, value);
  t.locale = lang === "ru" ? "ru-RU" : undefined;
  return t;
}

const TRANSLATORS: Record<ZyraLanguage, ZyraT> = { en: makeT("en"), ru: makeT("ru") };

export function zyraText(lang: ZyraLanguage): ZyraT {
  return TRANSLATORS[lang];
}

/** Provided by the chat page (session language) and the task detail / quick view (task language). */
export const ZyraLanguageContext = createContext<ZyraLanguage>("en");

export function useZyraText(): ZyraT {
  return zyraText(useContext(ZyraLanguageContext));
}
