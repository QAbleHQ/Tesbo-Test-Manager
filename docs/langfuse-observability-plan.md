# Langfuse integration plan — full traceability for Zyra and every other model call

Status: **Phase 1 shipped, partially.** `src/observability/` (`langfuse.ts`, `ai-trace.ts`) exists and
is wired into `buildZyraChatDecision`: session/user identity, Jira context, knowledge context,
existing-coverage, the router call, the generator call (`generateZyraChatTestcasesWithAi`), and a
`reply-reconciliation` guardrail span are all traced today. **Not yet done**, still matching this
doc's original Phase 1–4 scope below: model-price seeding (§3.5), the remaining call sites in §1.1
(#2, #3, #6–9), scores/evals (Phase 3), and dashboards/alerts (Phase 4). This header was stale for a
while — it read "no product code has been changed" after Phase 1's module had already shipped; keep
it in sync with reality going forward rather than treating this doc as a proposal once code exists.
Target instance: **self-hosted Langfuse OSS v4.17.0**, project `Tesbo Test Manager` (org `Tesbo`).

Scope: end-to-end observability (traces, token/cost accounting, quality scores) over every LLM and
embedding call the product makes, without changing what Zyra does.

---

## 0. Verified against the live instance (2026-08-25)

Everything below was confirmed by probing the running deployment and by pushing a real nested trace
through the SDK — not read off documentation. Two spike traces exist on the instance under
environment `spike-local`; they are filterable and harmless, but that is where they came from.

| Check | Result |
|---|---|
| Instance reachable | `GET /api/public/health` → `200 {"status":"OK","version":"4.17.0"}` |
| Credentials in `.env` | valid — resolve to project `Tesbo Test Manager`, org `Tesbo` |
| Env var naming | **`LANGFUSE_BASE_URL` is correct** — SDK checks it *first*, then `LANGFUSE_BASEURL` |
| OTel ingestion | `POST /api/public/otel/v1/traces` → `200`, event persisted to blob storage |
| Nested trace round-trip | **works** — `agent` → `retriever` / `generation` / `tool` / `guardrail` all landed under one trace, with `sessionId` and `userId` attached |
| Deterministic trace ids | `createTraceId(seed)` confirmed stable — same seed, same id |
| Write mode | `events_only` — the **deprecated** read APIs are off (see §3.4) |
| Cost computation | **broken for our models** — see §3.5 |
| Secret masking | **weaker than assumed** — see §7 |

### Corrections to the first draft of this plan

1. **SDK is v5, not v4.** `@langfuse/tracing` / `@langfuse/otel` are at **5.10.1**. Server versioning
   (v4.17.0) and SDK versioning are independent lines. The legacy standalone `langfuse` package is
   at 3.38.20 and is not what we want.
2. **Migration V84 is no longer needed.** `createTraceId(seed)` is deterministic, so the trace id for
   a chat message is `createTraceId(zyra_chat_messages.id)` — recomputable at any time, works
   retroactively, no column, no backfill. See §5.
3. **The `mask` hook is not the safety net I described.** It only covers `input` and `output`. See §7.

---

## 1. Why — the concrete gaps in what we have today

Each item is something we currently **cannot answer** about our own production behaviour.

### 1.1 Nine model call sites, none correlated

Line numbers below are as of the 2026-08-25 spike and have drifted since (the file has grown past
15,000 lines) — the call sites and their names are still current, the exact `:N` addresses are not.

| # | Call site | File / line | Traced today |
|---|-----------|-------------|--------------|
| 1 | Zyra chat router (`zyraChatWithOpenAi`/`zyraChatWithAnthropic`) | `legacy.service.ts` | **yes** — router span, raw pre-parse completion text + `__salvaged` flag, `reply-reconciliation` guardrail span |
| 2 | Tool-decision finalizer | `legacy.service.ts` | no |
| 3 | Scenario planner (`planZyraChatScenarios`) | `legacy.service.ts` | no |
| 4 | Testcase generator (`generateZyraChatTestcasesWithAi` → `generateZyraWithProvider`) | `legacy.service.ts` | **yes**, for the interactive turn (including a plan's first, synchronous batch) — the background continuation loop (`continueZyraChatPlan`) still has no open trace to attach to, unchanged from before |
| 5 | Testcase generator (Anthropic wire) | `legacy.service.ts` | same as #4 — one call site, both provider wires |
| 6 | Agent memory summariser | `legacy.service.ts` | no |
| 7 | Knowledge-file transcription | `legacy.service.ts` | no |
| 8 | RAG embeddings | `rag/rag-ai-allocation.ts` | no |
| 9 | Integration sync decisions | `integration-sync-decisions.ts` | no |

`testZyraAiConnection` (`:8316`) is a health probe — deliberately excluded, it would skew every
error-rate panel.

### 1.2 One user message fans out to four-plus model calls, invisibly

```
sendZyraChatMessage
  └─ buildZyraChatDecision            (:8642)
       ├─ 8 parallel context fetches  (RAG, KB folders, Jira, existing testcases, snapshot, history)
       ├─ AI call #1  router          (:8756)
       └─ AI call #2  finalizer       (:8761)  — conditional
  └─ startZyraChatPlan                (:9269)
       ├─ AI call #3  scenario plan   (:9287)  — exhaustive requests only
       └─ AI call #4..N generator     (:9303, :9323, :9423)
  └─ applyZyraChatOperations          (:8904)  — what actually got written
  └─ rememberZyraTurn                 (:10083) — AI call N+1
```

When a user reports "Zyra said it saved 20 cases and I see none," we have the reply text and an
activity JSON blob. We do not have the prompt, the router's decision, what RAG retrieved, which batch
failed, or the token spend. That is the bug class the changelog in `docs/zyra-agent-behaviour.md` is
largely made of.

### 1.3 We throw away the token usage we already parse

`generateZyraWithOpenAi` (`:10866`) and `generateZyraWithAnthropic` (`:10930`) both extract
`{ input, output, total, cached }`. The only use is a prose string at `:9833`:

```ts
detail: `Updated this task with ${aiResult.drafts.length} regenerated draft(s). Cached input tokens: ${aiResult.usage.cached}.`
```

No table, no aggregate. **"What did Zyra cost this workspace last month" is unanswerable today.** The
other seven sites do not parse usage at all.

### 1.4 Background plans survive restarts and are completely dark

`resumeInterruptedZyraChatPlans` (`:843`) picks up `zyra_chat_sessions.active_plan` rows with
`status = 'running'` after a restart and resumes via `continueZyraChatPlan` (`:9382`), outside any
HTTP request. No correlatable record exists.

### 1.5 RAG retrieval quality is unmeasurable

`retrieveKnowledgeContext` (called at `:8660`) is documented as "never throws, resolves to `[]` on
any failure." Right for resilience, terrible for observability: a silently-empty retrieval is
indistinguishable from a working one, and is the likeliest cause of Zyra answering from guesswork.

### 1.6 We have quality signal and ignore it

- `zyraFeedback` (`:9762`) — free-text review feedback, stored as a column, never analysed.
- `ai_generation_requests` already tracks `generated_count` **and** `saved_count`. That ratio is a
  real draft-acceptance metric. Nobody looks at it.
- `zyraDeleteDraft` (`:9890`) — an explicit per-draft rejection signal. Discarded.

---

## 2. Decisions

**D1 — Hosting: resolved.** Self-hosted OSS, already deployed and verified. No third-party
subprocessor question, no DPA. This was the open question in the first draft; it is closed.

**D2 — Production from day one?** My recommendation: yes, behind `LANGFUSE_ENABLED`. The bugs worth
seeing are production bugs; staging traffic is us, and we already know what we typed.

**D3 — Retention.** Traces carry customer KB content, Jira bodies and test cases. Suggest a finite
window (30 days) on trace content, indefinite on aggregates. Needs your call.

**D4 — new: the instance is served over plain HTTP on a public IP.** See §7.1. This needs an
answer before we start sending real customer prompts through it.

---

## 3. Architecture

### 3.1 No LLM SDK — we instrument manually, and that is fine

**We do not need LangChain.** Worth stating plainly since the names get conflated: Langfuse's
one-line integrations are an OpenAI-SDK wrapper or a LangChain callback. We use neither — every call
is a raw `fetch` against a URL built by `providerChatUrl` / `normalizeAnthropicMessagesUrl`. That
multi-provider abstraction (openai · anthropic · azure · gemini · openrouter · custom, per
`legacy.service.ts:488-580`) suits the product better than LangChain would, and switching would be a
rewrite of a 12,000-line service to gain nothing. Manual instrumentation is a first-class Langfuse
path and is what the verified spike used.

### 3.2 New module: `Tesbo-Backend-Nest/src/observability/`

```
observability/
  observability.module.ts       # global module, registered in app.module.ts
  langfuse.service.ts           # SDK lifecycle: bootstrap, shutdown, forceFlush
  ai-trace.service.ts           # the only API the rest of the codebase calls
  ai-trace.types.ts
  redaction.ts                  # §7
  ai-trace.service.spec.ts      # unit tests, no network
  redaction.spec.ts
```

Dependencies to pin:

```
@langfuse/tracing@5.10.1
@langfuse/otel@5.10.1
@opentelemetry/api@^1.9.0
@opentelemetry/sdk-node
```

`AiTraceService` exposes three things; nothing else touches the SDK:

```ts
startTurn(ctx): TurnHandle                                   // opens the trace, never throws
observeSpan<T>(handle, name, type, fn): Promise<T>           // non-LLM work worth seeing
observeGeneration<T>(handle, name, meta, fn): Promise<T>     // one model call
```

Call sites change by ~4 lines each — no restructuring of `legacy.service.ts`.

**Bootstrap gotcha (hit during the spike):** `NodeSDK` auto-configures default OTLP exporters that
try to reach `localhost:4318` and crash the process with an unhandled `Request timed out`. The
bootstrap must disable them (`OTEL_TRACES_EXPORTER=none`, `OTEL_METRICS_EXPORTER=none`,
`OTEL_LOGS_EXPORTER=none`, or use `NodeTracerProvider` directly with only `LangfuseSpanProcessor`).

### 3.3 The trace model — verified working

The SDK's typed observation kinds map onto our domain far better than a generic span/generation
split. All of these were confirmed landing correctly:

```
Langfuse session   ←→  zyra_chat_sessions.id      (the whole conversation replays as one session)
Langfuse user      ←→  users.id
Langfuse trace id  ←→  createTraceId(zyra_chat_messages.id)   — deterministic, see §5

trace  "zyra.chat.turn"                                    [agent]
  ├─ gather-context                                        [span]
  │    ├─ rag-retrieval        retrieveKnowledgeContext     [retriever]  ← fixes §1.5
  │    ├─ knowledge-folder-lookup                           [span]
  │    ├─ jira-snapshot                                     [span]
  │    └─ existing-testcases                                [span]
  ├─ router                    zyraChatWith{OpenAi,Anthropic} [generation]
  ├─ finalize-tool-decision    finalizeZyraToolDecisionWithAi [generation]
  ├─ plan                      startZyraChatPlan            [chain]
  │    ├─ scenario-plan        planZyraChatScenarios        [generation]
  │    └─ generate-batch ×N    generateZyraWithProvider     [generation]
  ├─ apply-operations          applyZyraChatOperations      [tool]
  ├─ capability-gate           normalizeZyraCapabilities    [guardrail]
  ├─ reply-reconciliation      finalizeZyraChatReply        [guardrail]  ← see below
  └─ remember-turn             rememberZyraTurn             [span → generation]

trace  "zyra.task.generate"   ←→ ai_generation_requests.id
trace  "rag.ingest"           ←→ embedding job     [embedding]
trace  "integration.sync"     ←→ sync decision     [generation]
```

The highest-value pairing in this design is `router` [generation] sitting beside `apply-operations`
[tool] and `reply-reconciliation` [guardrail] **in one trace**: what the model *claimed* next to what
the database *actually did*. That is the mutation-claim problem from `docs/zyra-agent-behaviour.md`
§1 made visible — and in Phase 3 it becomes an automated score rather than a thing someone notices.

**Constraint found during the spike:** `propagateAttributes` metadata values must be **strings ≤200
characters**; non-string values are silently dropped with a warning. So `capabilities` and similar
objects must be flattened to short strings, not passed as objects.

### 3.4 Reading data back — v4 changed the API

The instance runs write mode `events_only`, which turns **off the deprecated read endpoints**
(`/api/public/traces`, `/api/public/observations`, `/api/public/sessions`, `/api/public/v2/scores`,
`/api/public/metrics/daily` — all return 404 with a v4 notice). This is not a broken deployment; v4
replaced them.

Use instead:

```
GET /api/public/v2/observations?fromStartTime=…&toStartTime=…    # always bound the window
```

Two consequences that matter to us:

- **e2e assertions** and any programmatic reads must target the v2 endpoint, not the v1 paths that
  most tutorials still show.
- The v2 list endpoint returns a **truncated projection** (`events_core`) — `input`, `output`,
  `metadata` and `model` are not in the row. Do not write an assertion that "the secret is absent
  from the list response" and call it a leak test; it proves nothing. Assert on the **outbound
  payload** instead (§9).

### 3.5 Cost is currently computed as zero for the models we actually use

Langfuse derives cost from a model-price definition matched against the model name. The instance has
**87 definitions, none newer than the 3.5 / 4o era**. Checked against the models our provider catalog
can select:

| Model | Priced on instance |
|---|---|
| `claude-sonnet-4-6` | **no** |
| `claude-haiku-4-5` | **no** |
| `claude-sonnet-4`, `claude-sonnet-4-20250514` | **no** |
| `claude-3-7-sonnet` | **no** |
| `gpt-4.1`, `gpt-4.1-mini` | **no** |
| `gemini-2.0-flash` | **no** |
| `claude-3-5-sonnet-20241022`, `gpt-4o`, `text-embedding-3-small` | yes |

**8 of 11 unpriced.** The spike's generation came back with `inputPrice`, `outputPrice`, `totalPrice`
and `modelId` all null, confirming it end to end. Since cost accounting is one of the two headline
reasons for this work (§1.3), seeding model definitions via `POST /api/public/models` is a
**required Phase 1 task**, not a nice-to-have. Token counts are captured regardless.

---

## 4. Phased implementation

### Phase 0 — spike ✅ done

Completed while writing this plan: version pinned, ingestion proven, trace hierarchy proven, masking
behaviour characterised, cost gap found. Findings are §0 and §7. No repo changes.

### Phase 1 — Module + Zyra chat path (~2–3 days) — 🟡 partially shipped

1. `src/observability/` per §3.2, registered globally, with the `NodeSDK` exporter guard. **Done.**
2. `AppConfigService` additions (§6), inert when `LANGFUSE_ENABLED=false`. **Done.**
3. Seed model-price definitions for the 8 unpriced models (§3.5). **Not done** — cost still computes
   to zero for the models this catalog actually serves; still a required task, not optional.
4. Instrument, in order: `sendZyraChatMessage` → `buildZyraChatDecision` →
   `finalizeZyraToolDecisionWithAi` → `startZyraChatPlan` / `continueZyraChatPlan` →
   `generateZyraWithProvider` → `applyZyraChatOperations`.
   **Done**: `buildZyraChatDecision` (router span, raw completion + `__salvaged`, reconciliation
   guardrail span), `generateZyraWithProvider` for the interactive path (including a plan's first
   batch). **Not done**: `finalizeZyraToolDecisionWithAi` (the `jira_pending_testcases` tool path),
   `continueZyraChatPlan`'s own background batches (no open trace to attach to — each batch would
   need its own trace, not a child of one that already ended), `applyZyraChatOperations` as its own
   `[tool]` span (its outcome is currently only visible via the reconciliation guardrail span's
   `appliedCount`/`proposedCount`, not as a distinct observation).
5. Shutdown flush in `main.ts` (§8). Not verified as part of this pass — check before relying on it.
6. e2e coverage per §9 (local capture stub against the real HTTP stack, fail-closed base URL,
   Langfuse-unreachable failure isolation, etc.): **still not written, not run.** What this pass did
   add is `src/observability/ai-trace.spec.ts` — previously nonexistent (§3.2 named
   `ai-trace.service.spec.ts` as a Phase 1 deliverable that never got written) — unit-testing
   `ai-trace.ts`'s own contract directly with `@langfuse/tracing` and `isTracingEnabled` mocked: the
   raw completion lands in `output.rawCompletion` (never `metadata`, matching the §7.2 masking
   constraint) alongside the parsed decision, `salvaged`/`bannerFired` land in metadata as plain
   booleans/strings, `recordReconciliation` derives the identical trace id `startZyraTurn` would for
   the same messageId (asserted directly, not assumed), and every function stays a no-op that never
   throws when tracing is off or the SDK itself throws. This proves ai-trace.ts's own behavior
   correctly; it does not prove the real SDK/network path, which is what §9's e2e list is for.

### Phase 2 — Remaining call sites (~1 day)

`summarizeForZyraMemory`, `transcribeKnowledgeFile`, `embedTexts` (inside `RagEmbeddingProcessor`),
`integration-sync-decisions`. Extend usage parsing to the sites that lack it (`zyraJsonCompletion`,
`zyraChatWith*`, `summarizeForZyraMemory`) so cost is complete rather than partial. BullMQ processors
flush per job.

### Phase 3 — Scores and evals (~1–1.5 days)

| Score | Source | Type |
|---|---|---|
| `user_feedback` | `zyraFeedback` (`:9762`) | categorical |
| `draft_acceptance` | `saved_count / generated_count` | numeric 0–1 |
| `draft_rejected` | `zyraDeleteDraft` (`:9890`) | boolean |
| `mutation_claim_consistency` | reply claims vs `applyZyraChatOperations` | boolean, automated |
| `rag_hit` | retrieval ≥1 doc while KB capability ON | boolean, automated |
| `router_action` | `action_type` distribution | categorical, drift alarm |

The last three we compute ourselves — no LLM-as-judge, no extra token cost. Deterministic trace ids
(§5) mean scores can be attached retroactively from any of these tables.

### Phase 4 — Dashboards and alerts (~0.5 day)

Cost per workspace/project/model; p50/p95 latency per call site; error rate by provider (feeding the
existing `describeProviderError` categories); RAG hit rate; draft-acceptance trend.

### Phase 5 — Prompt management — **recommend deferring**

Langfuse can host `zyraSystemPrompt()` (`:10499`), `zyraStaticSourcePrompt()` (`:10511`),
`zyraDynamicTaskPrompt()` (`:10550`) and the ~60-line inline context array in
`buildZyraChatDecision`, giving versioning and rollback without a deploy. Two reasons to wait:

1. It puts Langfuse in the **critical path** — Zyra degrades if the prompt fetch does. Mitigable with
   cache + in-code fallback, but it is a new failure mode for zero observability gain.
2. It conflicts with `docs/zyra-agent-behaviour.md` as the contract of record: behaviour could change
   in an external UI with no changelog entry, which is exactly what that doc exists to prevent.

Revisit once we are iterating on prompts weekly.

---

## 5. No schema change needed

The first draft proposed a migration to store `trace_id`. **Dropped** — `createTraceId(seed)` is
deterministic (verified), so:

```ts
traceIdFor(chatMessageId)  = await createTraceId(chatMessageId)   // zyra_chat_messages.id
traceIdFor(generationTask) = await createTraceId(taskId)          // ai_generation_requests.id
```

Same id every time, from data we already store. A support report maps to its trace by computing the
id — no column, no backfill, and it works for rows written before the feature shipped. Background
plan resumption reattaches the same way, seeding from the originating message id.

This also removes the migration from scope, which shrinks the e2e surface (§9) and the review risk.

---

## 6. Configuration

```ts
readonly langfuseEnabled     = this.boolean("LANGFUSE_ENABLED", false);   // default OFF
readonly langfusePublicKey   = this.string("LANGFUSE_PUBLIC_KEY", "");
readonly langfuseSecretKey   = this.string("LANGFUSE_SECRET_KEY", "");
readonly langfuseBaseUrl     = this.string("LANGFUSE_BASE_URL", "");      // no default — see below
readonly langfuseEnvironment = this.string("LANGFUSE_ENVIRONMENT", "development");
readonly langfuseFlushAt     = this.integer("LANGFUSE_FLUSH_AT", 20);
readonly langfuseFlushIntervalMs = this.integer("LANGFUSE_FLUSH_INTERVAL_MS", 5_000);
```

Your `.env` already carries `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_BASE_URL`, and
`LANGFUSE_BASE_URL` is the name the SDK prefers. Add `LANGFUSE_ENABLED` and `LANGFUSE_ENVIRONMENT`;
document placeholders in `docker.env.example`.

**Fail closed on the base URL.** If `baseUrl` is unset the SDK silently defaults to
`https://cloud.langfuse.com`. A container that fails to load `.env` would therefore ship customer
prompts to a third party by default. The module must **refuse to initialise** when the resolved base
URL is empty or points at `cloud.langfuse.com` without an explicit `LANGFUSE_ALLOW_CLOUD=true`.

`LANGFUSE_ENVIRONMENT` must differ across local / staging / production or the cost dashboards mix and
become meaningless. Default `LANGFUSE_ENABLED=false` keeps e2e runs, local dev, and the open-source
fork unaffected unless switched on.

---

## 7. Security

### 7.1 The instance is plain HTTP on a public IP — needs a decision (D4)

`LANGFUSE_BASE_URL` is `http://208.87.133.122:3100`. Every export sends, in cleartext across the
public internet:

- the **Basic auth header** carrying the Langfuse public + secret key, and
- **full prompt and completion content** — customer knowledge-base documents, Jira ticket bodies,
  test cases, user messages.

Anyone on-path can read all of it and replay the credentials. Self-hosting removed the third-party
question; it did not make the transport safe. Before real traffic flows: put it behind TLS (a
reverse proxy with a certificate, or a private network / VPN / tunnel between the backend and the
Langfuse host) and switch `LANGFUSE_BASE_URL` to `https://`. This is cheap to fix and I would not
enable production tracing without it.

### 7.2 The `mask` hook covers less than advertised — measured

The first draft treated the processor-level `mask` as a belt-and-braces net. **It is not.** I planted
canary strings in every field and captured the outbound payload:

| Field set via | Reaches `mask`? |
|---|---|
| observation `input` | yes — redacted |
| observation `output` | yes — redacted |
| observation `metadata` | **no — sent verbatim** |
| generation `model` | **no — sent verbatim** |
| propagated `sessionId` / `userId` / `tags` | **no — sent verbatim** |
| propagated `metadata` | **no — sent verbatim** |

So `mask` protects exactly two fields. Everything else is whatever we put there.

### 7.3 Therefore: the allowlist is the only real defence

**The `key` object threaded through almost every AI helper contains the plaintext provider API key** —
`zyraJsonCompletion(provider, model, key: Body, …)`, `zyraChatWithOpenAi(key: Body, …)`,
`generateZyraWithProvider({ apiKey, … })`. A careless `metadata: params` would ship a live — and per
our own notes sometimes **production** — provider key straight to the trace store, and §7.2 shows the
mask would not stop it.

1. **Strict allowlist.** `AiTraceService` accepts only explicitly named scalar fields. It never
   receives a `key`/`params` object to pick from. This is mandatory, not defence-in-depth.
2. **Keep the `mask` anyway** for input/output, where prompt bodies could echo a key back.
3. **Never trace headers.** `providerAuthHeaders` output is off-limits.
4. **Test it at the payload level** (§9) — not against the read API, which truncates (§3.4).

---

## 8. Failure isolation — Langfuse must never break Zyra

- Every `AiTraceService` method is internally `try/catch`ed and returns a no-op handle on failure. A
  tracing bug produces a log line, never a 500.
- **No blocking flush on the request path.** Background batching only.
- Short ingestion timeout; drop on failure. A dead Langfuse must not add latency. (Note the measured
  round-trip to the instance is ~0.8–1.2s, so this is not a localhost-fast dependency.)
- **Flush on shutdown.** `main.ts` needs `enableShutdownHooks()` + `forceFlush()` in
  `onApplicationShutdown`, else every container restart drops the last seconds of traces — and
  restarts are exactly when the interesting traces happen.
- **BullMQ processors flush per job.**
- Circuit-break after N consecutive failures rather than retrying into a wall.
- The `NodeSDK` default-exporter crash from §3.2 is itself an example: an unguarded bootstrap took
  the process down. The bootstrap gets a unit test.

---

## 9. e2e coverage — Phase 1 of the mandate, enumerated up front

Per `CLAUDE.md`, this ships with real, run, passing e2e tests. Scenarios listed before writing, as
required.

**Harness:** point `LANGFUSE_BASE_URL` at a local capture stub that records the outbound OTLP body.
This was already prototyped during the spike and works. It makes emission assertable, keeps the suite
hermetic, and lets outages and bad credentials be simulated deterministically. It is also the *only*
correct place to assert on secrets, since the v2 read API truncates (§3.4).

### Primary
1. Chat message with tracing on → reply byte-identical to untraced; captured payload contains the
   §3.3 observation tree with correct types (`agent` / `retriever` / `generation` / `tool` /
   `guardrail`).
2. The trace id in the payload equals `createTraceId(zyra_chat_messages.id)` — the §5 correlation
   contract.

### Surrounding
3. Tracing **disabled** → identical behaviour, nothing emitted.
4. Generation task (`zyraTask` / `processZyraTask`) → trace seeded from `ai_generation_requests.id`.
5. Background plan → batches from `continueZyraChatPlan` land under the **same** trace and session.
6. Draft save / delete flows unchanged with tracing on.

### Edge cases
7. **Langfuse unreachable** (stub refuses connections) → Zyra answers normally, no user-visible
   error, latency within budget.
8. **500 / 401 from Langfuse** → same.
9. **No AI key allocated** → `zyraDegradedDecision` path, nothing emitted, no crash.
10. **Secret leakage — the §7.2 finding.** Assert the captured payload contains no `sk-`, `sk-ant-`,
    `Bearer `, or the allocated key's value, **in `metadata`, `tags`, `model` and propagated
    attributes specifically** — the fields the mask does not cover.
11. **Fail-closed base URL**: unset / `cloud.langfuse.com` without opt-in → module refuses to
    initialise, nothing is sent anywhere (§6).
12. **Authorization**: unauthenticated caller gets the unchanged 401, emits nothing.
13. **Cross-tenant**: account B's traces carry B's org/project; nothing of A's appears in B's.
14. **Plan gating**: read-only/downgraded workspace behaves identically with tracing on.
15. **Empty / whitespace-only message** → unchanged validation response.
16. **Concurrency**: two sessions in parallel do not cross-attach spans — the real risk in an
    OTel-context design, and the reason this scenario exists.
17. **Metadata constraints**: a >200-char or non-string metadata value is flattened, not dropped
    silently (§3.3).

### Impacted specs
- `e2e/api/zyra.spec.ts` — primary owner, extend
- `e2e/ui/zyra.spec.ts` — scenarios 1, 6
- `e2e/api/authorization.spec.ts` — scenarios 12, 13
- `e2e/api/knowledge-base.spec.ts` — Phase 2 (RAG embedding traces)
- `e2e/api/integrations.spec.ts` — Phase 2 (sync-decision traces)

No migration in scope (§5), so the migration scenarios from the first draft are dropped.

Selection announced with `--list` counts, run at `--workers=10` in its own Terminal window via
`scripts/e2e-run.sh`, **after asking** — per the standing protocol.

---

## 10. What I would deliberately *not* do

- **Not adopt LangChain.** Langfuse needs no LangChain; adopting it means rewriting a 12,000-line
  service for negative benefit.
- **Not put Langfuse in the request critical path** — no blocking flush, no prompt fetch on the hot
  path (Phase 5).
- **Not trace the health probe** `testZyraAiConnection`.
- **Not build our own tracing tables.** `ai_generation_requests` already does a fraction of this
  badly; extending it into a homegrown observability store is a year of work already done.
- **Not rely on `mask` for secrets** — measured, §7.2.
- **Not sample below 100%** until volume forces it.

---

## 11. Effort

| Phase | Estimate |
|---|---|
| 0 — spike | ✅ done |
| 1 — module + Zyra chat path + model prices + e2e | 2–3 d |
| 2 — remaining call sites + complete usage parsing | 1 d |
| 3 — scores and evals | 1–1.5 d |
| 4 — dashboards and alerts | 0.5 d |
| 5 — prompt management | deferred |
| **Total to full value** | **4.5–6 days** |

Down from the first estimate: hosting is already done and the migration is no longer needed.

Not included: putting TLS in front of the Langfuse instance (§7.1), which is an infra task.

---

## 12. What I need from you

1. **D4 — TLS on the Langfuse endpoint.** It is plain HTTP on a public IP; credentials and customer
   prompts would cross the internet in cleartext. I would fix this before enabling production
   tracing. Do you want to front it with a proxy/cert, or put it on a private network?
2. **D2** — production tracing from day one? (Recommend: yes, once D4 is done.)
3. **D3** — retention window for trace content.
4. Approval to start **Phase 1**. I would not build past it before you have looked at real traces and
   confirmed they show what you actually wanted.

---

## Changelog

- **2026-08-25** — Plan drafted from a survey of the nine live model call sites.
- **2026-08-25** — Revised after a Phase 0 spike against the live instance: SDK is v5.10.1 not v4;
  migration V84 dropped in favour of deterministic `createTraceId`; `mask` measured to cover only
  input/output; v4 `events_only` read-API change documented; 8-of-11 model price definitions found
  missing; plain-HTTP transport raised as D4.
- **2026-09-10** — Phase 1's `src/observability/` module and its wiring into `buildZyraChatDecision`
  shipped at some point after the above (this doc's header wasn't updated then — fixed now). Found
  three real gaps in what shipped while investigating a phantom-success bug report ("Zyra said 8 test
  cases were staged for review; nothing existed") and closed the two directly relevant to it:
  (1) `recordGeneration`'s `output` for the router call was always the *parsed* decision, never the
  literal completion text — so a trace for exactly this bug class would have shown the same lossy
  salvaged fragment already visible in the reply, not the malformed JSON that caused it. Fixed:
  `recordGeneration` gained `rawOutput`/`salvaged` fields, routed through `output` (masked) never
  `metadata` (not masked, per §7.2). (2) The generator call
  (`generateZyraChatTestcasesWithAi`/`generateZyraWithProvider`) — the one that actually authors
  drafts — had no span at all; now traced for the interactive path (a background plan batch still has
  no open trace to attach to — noted in §4 rather than silently left undocumented).
  (3) `reconcileZyraReply`'s decision (which banner fired, requested/applied/proposed counts) was
  invisible on the trace, and — found while wiring this — could not simply become a child of the
  router's own span: that span's root observation is already ended (`endZyraTurn`) by the time
  reconciliation runs in the caller, several turns' worth of return paths earlier. Rather than
  restructure who owns ending the trace across `buildZyraChatDecision`'s ~10 return points (invasive,
  and several of those paths — capability-disabled, degraded-mode — don't call `endZyraTurn` at all
  today, itself a pre-existing gap left as-is), `recordReconciliation` opens its own observation
  attached to the SAME deterministic trace id (`createTraceId(messageId)`), the same bootstrap
  `startZyraTurn` itself uses. Added `src/observability/ai-trace.spec.ts` (previously nonexistent —
  see §3.2's original, never-fulfilled `ai-trace.service.spec.ts` line item) covering all of the
  above at the unit level, `@langfuse/tracing` mocked. §9's actual e2e list is still not written.
