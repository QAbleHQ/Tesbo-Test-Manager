"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  authMe,
  getProject,
  createExecutionApiKey,
  listExecutionApiKeys,
  type ExecutionApiKey,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

/* ─── Primitives ────────────────────────────────────────────────── */

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">
          {lang}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="rounded px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)] transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-[var(--foreground)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function StepCard({
  step,
  title,
  done,
  onToggle,
  children,
}: {
  step: number;
  title: string;
  done: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <button
        type="button"
        onClick={onToggle}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors ${
          done
            ? "bg-[var(--success)] text-white"
            : "bg-[var(--ai-surface)] text-[var(--ai-primary)]"
        }`}
        aria-label={done ? `Mark step ${step} incomplete` : `Mark step ${step} complete`}
      >
        {done ? (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          step
        )}
      </button>
      <div className="min-w-0 flex-1">
        <h3
          className={`text-base font-semibold transition-colors ${
            done ? "text-[var(--muted)] line-through" : "text-[var(--foreground)]"
          }`}
        >
          {title}
        </h3>
        {!done && <div className="mt-3 space-y-3">{children}</div>}
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--ai-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ai-primary)]">
      {children}
    </span>
  );
}

const executionInitialKeyStorageKey = (id: string) => `tesbox_execution_initial_key_${id}`;
const STEP_STORAGE_KEY = (id: string) => `tesbox_integration_steps_${id}`;

function loadSteps(projectId: string): boolean[] {
  try {
    const raw = localStorage.getItem(STEP_STORAGE_KEY(projectId));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [false, false, false, false, false];
}

function saveSteps(projectId: string, steps: boolean[]) {
  try {
    localStorage.setItem(STEP_STORAGE_KEY(projectId), JSON.stringify(steps));
  } catch { /* ignore */ }
}

/* ─── Page ──────────────────────────────────────────────────────── */

export default function IntegrationPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  // API key state
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [existingKeys, setExistingKeys] = useState<ExecutionApiKey[]>([]);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Step completion tracking
  const [steps, setSteps] = useState<boolean[]>([false, false, false, false, false]);

  const toggleStep = useCallback(
    (idx: number) => {
      setSteps((prev) => {
        const next = [...prev];
        next[idx] = !next[idx];
        saveSteps(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  const completedCount = steps.filter(Boolean).length;

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((p) => {
          setProject(p);
          setSteps(loadSteps(projectId));

          // Check for one-time key from project creation
          try {
            const sk = executionInitialKeyStorageKey(projectId);
            const raw = sessionStorage.getItem(sk);
            if (raw) {
              setActiveKey(raw);
              sessionStorage.removeItem(sk);
            }
          } catch { /* ignore */ }
        })
        .catch(() => router.replace("/projects"))
        .finally(() => setLoading(false));

      listExecutionApiKeys(projectId)
        .then((res) => setExistingKeys(res.keys ?? []))
        .catch(() => {});
    });
  }, [projectId, router]);

  const handleGenerateKey = async () => {
    setGeneratingKey(true);
    setKeyError(null);
    try {
      const result = await createExecutionApiKey(projectId, "Integration guide key");
      setActiveKey(result.key);
      const refreshed = await listExecutionApiKeys(projectId);
      setExistingKeys(refreshed.keys ?? []);
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Failed to generate key");
    } finally {
      setGeneratingKey(false);
    }
  };

  const copyKey = () => {
    if (!activeKey) return;
    navigator.clipboard.writeText(activeKey);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  };

  if (loading || !project) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const apiBase = "https://exe.tesbo.io";
  const apiKeyDisplay = activeKey ?? "txe_your_api_key_here";
  const hasKey = !!activeKey;

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Integration Guide"
          subtitle="Run your Playwright tests on TesboX cloud infrastructure — from local dev or CI/CD."
        />
      }
    >
      <div className="mx-auto max-w-3xl space-y-8">

        {/* ── Progress bar ──────────────────────────────────── */}
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-[var(--foreground)]">
              Setup progress
            </p>
            <span className="text-xs font-medium text-[var(--muted)]">
              {completedCount}/5 steps
            </span>
          </div>
          <div className="mt-3 flex gap-1.5">
            {steps.map((done, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  done ? "bg-[var(--success)]" : "bg-[var(--border-subtle)]"
                }`}
              />
            ))}
          </div>
        </Card>

        {/* ── How it works ──────────────────────────────────── */}
        <Card className="border-l-[3px] border-l-[var(--ai-primary)] p-5">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ai-primary)]" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 5v14l11-7-11-7z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">How it works</p>
              <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
                The <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">@tesbox/cli</code> reads
                your Playwright spec files, extracts each <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">test()</code> as
                an individual job, and streams them to TesboX.
                Workers start executing immediately while remaining jobs are still being submitted — no waiting room.
                Parallelism, retries, and artifact collection are handled server-side.
              </p>
            </div>
          </div>
        </Card>

        {/* ── Steps ─────────────────────────────────────────── */}
        <div className="space-y-8">

          {/* Step 1: Generate API key */}
          <StepCard step={1} title="Generate your API key" done={steps[0]} onToggle={() => toggleStep(0)}>
            {activeKey ? (
              <div className="space-y-3">
                <Card className="border border-[var(--success)]/35 bg-[color-mix(in_oklab,var(--success)_6%,white)] p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <svg className="h-4 w-4 text-[var(--success)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1 8.618 3.04A12.02 12.02 0 0 1 12 21.035a12.02 12.02 0 0 1-8.618-15.091z" />
                      </svg>
                      <p className="text-sm font-semibold text-[var(--foreground)]">Key generated</p>
                    </div>
                    <Button type="button" variant="secondary" size="sm" onClick={copyKey}>
                      {keyCopied ? "Copied" : "Copy key"}
                    </Button>
                  </div>
                  <code className="block rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 font-mono text-sm break-all text-[var(--foreground)]">
                    {activeKey}
                  </code>
                  <p className="text-xs text-[var(--warning)]">
                    Save this key now. You will not be able to view the full key again after leaving this page.
                  </p>
                </Card>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-[var(--muted)]">
                  Generate an API key to authenticate your CLI requests. You can also manage keys
                  in <span className="font-medium text-[var(--foreground)]">Settings → API Keys</span>.
                </p>
                {existingKeys.length > 0 && (
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3">
                    <p className="text-xs text-[var(--muted)]">
                      This project already has {existingKeys.length} key{existingKeys.length !== 1 ? "s" : ""}.
                      You can use an existing key or generate a new one below.
                    </p>
                  </div>
                )}
                {keyError && (
                  <p className="text-sm text-[var(--error)]">{keyError}</p>
                )}
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleGenerateKey}
                  disabled={generatingKey}
                >
                  {generatingKey ? "Generating…" : "Generate API key"}
                </Button>
              </div>
            )}
          </StepCard>

          {/* Step 2: Install CLI */}
          <StepCard step={2} title="Install the CLI" done={steps[1]} onToggle={() => toggleStep(1)}>
            <p className="text-sm text-[var(--muted)]">
              Add the TesboX CLI as a dev dependency in your Playwright project.
            </p>
            <CodeBlock lang="bash" code="npm install -D @tesbox/cli" />
            <p className="text-xs text-[var(--muted)]">
              Requires Node.js 18+. The CLI is a lightweight wrapper — no browsers are installed.
            </p>
          </StepCard>

          {/* Step 3: Configure environment */}
          <StepCard step={3} title="Set up your environment" done={steps[2]} onToggle={() => toggleStep(2)}>
            <p className="text-sm text-[var(--muted)]">
              Add these variables to your shell or <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">.env</code> file
              so you don't need CLI flags every time.
            </p>
            <CodeBlock
              lang=".env"
              code={`TESBOX_API_KEY=${apiKeyDisplay}\nTESBOX_PROJECT_ID=${projectId}`}
            />
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-2">
              <p className="text-xs font-semibold text-[var(--foreground)]">Your project ID</p>
              <div className="flex items-center gap-2">
                <code className="rounded bg-[var(--surface-secondary)] px-2 py-1 text-xs font-mono text-[var(--foreground)]">
                  {projectId}
                </code>
                <Pill>auto-filled</Pill>
              </div>
            </div>
          </StepCard>

          {/* Step 4: Run tests */}
          <StepCard step={4} title="Run your first test" done={steps[3]} onToggle={() => toggleStep(3)}>
            <p className="text-sm text-[var(--muted)]">
              Point the CLI at your spec files. Each <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">test()</code> block
              becomes an isolated job that runs on TesboX infrastructure. Concurrency is managed server-side.
            </p>
            <CodeBlock
              lang="bash"
              code={`npx tesbox run "tests/**/*.spec.ts"`}
            />
            <p className="text-xs text-[var(--muted)]">
              Or with explicit flags:
            </p>
            <CodeBlock
              lang="bash"
              code={`npx tesbox run "tests/**/*.spec.ts" \\\n  --api-key ${apiKeyDisplay} \\\n  --project-id ${projectId} \\\n  --start-url https://staging.example.com`}
            />
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3">
              <p className="text-xs font-semibold text-[var(--foreground)]">Live output preview</p>
              <pre className="mt-2 text-xs leading-relaxed text-[var(--muted)] font-mono whitespace-pre overflow-x-auto">{`  Phase 1/4: Hunting for spec files...

  Discovering tests matching: tests/**/*.spec.ts

  Found 3 spec files:
    tests/login.spec.ts
    tests/checkout.spec.ts
    tests/dashboard.spec.ts

  Phase 2/4: Turning tests into tiny job rockets (1 test = 1 job)...
  Expanded 3 spec files into 8 testcase jobs (1 test = 1 job).

  Phase 3/4: Launching run and drip-feeding jobs in real time...
  Submitting 8 jobs to ${apiBase}...

  Run created: a1b2c3d4-...
  Total jobs: 8 | Total test cases: 8

  Phase 4/4: Watching the race until submit + execution both cross the finish line...

  Status: running | Submitted: 8/8 | Completed: 5/8 (62%) | Passed: 5 | Failed: 0 | Running: 3 | Queued: 0 | Rate: 48.2/min | ETA finish: ~4s
  Status: completed | Submitted: 8/8 | Completed: 8/8 (100%) | Passed: 8 | Failed: 0 | Running: 0 | Queued: 0 | Rate: 52.1/min | ETA finish: ~0s

  ─────────────────────────────────────────────────────
  Test Results
  ─────────────────────────────────────────────────────

  Spec                                      Status     Duration
  ────────────────────────────────────────   ─────────  ──────────
  tests/login.spec.ts :: login flow          passed    3.2s
  tests/login.spec.ts :: logout flow         passed    2.1s
  tests/checkout.spec.ts :: add to cart      passed    5.1s
  tests/checkout.spec.ts :: payment          passed    4.8s
  tests/dashboard.spec.ts :: load widgets    passed    2.8s
  ...

  ─────────────────────────────────────────────────────
  ✓ All 8 tests passed
    Server execution: 5.1s
    Total wall clock: 12.3s  (submit → results)
  ─────────────────────────────────────────────────────`}</pre>
            </div>
          </StepCard>

          {/* Step 5: CI/CD */}
          <StepCard step={5} title="Add to CI/CD" done={steps[4]} onToggle={() => toggleStep(4)}>
            <p className="text-sm text-[var(--muted)]">
              Add one step to your pipeline. No browser install needed — tests run on TesboX infrastructure.
            </p>
            <CodeBlock
              lang="yaml"
              code={`# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Run tests on TesboX
        run: npx tesbox run "tests/**/*.spec.ts"
        env:
          TESBOX_API_KEY: \${{ secrets.TESBOX_API_KEY }}
          TESBOX_PROJECT_ID: ${projectId}`}
            />
            <p className="text-sm text-[var(--muted)]">
              Add <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">TESBOX_API_KEY</code> to
              your repository secrets under GitHub → Settings → Secrets and variables → Actions.
            </p>
          </StepCard>
        </div>

        {/* ── CLI Reference ─────────────────────────────────── */}
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">CLI Reference</h3>
          <CodeBlock
            lang="bash"
            code={`tesbox run <glob> [options]
tesbox connect-tesbo [options]

Run Options:
  --api-key <key>           API key (or TESBOX_API_KEY env)
  --project-id <id>         Project ID (or TESBOX_PROJECT_ID env)
  --api-url <url>           API URL (default: ${apiBase})
  --start-url <url>         Base URL passed to your tests
  --execution-mode <mode>   auto | script | project (default: auto)
  --timeout <ms>            Overall run timeout (default: 1800000 = 30min)
  --poll-interval <ms>      Status poll interval (default: 2000)

Tesbo Integration:
  --tesbo-api-url <url>     Tesbo backend URL for report ingestion
  --tesbo-ui-url <url>      Tesbo frontend URL for run links
  --tesbo-access-key <key>  Tesbo project access key
  --run-name <name>         Tesbo report run name`}
          />
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-xs font-semibold text-[var(--foreground)]">Execution modes</p>
            <ul className="space-y-1 text-xs text-[var(--muted)]">
              <li>
                <code className="rounded bg-[var(--surface-secondary)] px-1 py-0.5 text-[11px] font-mono">auto</code>{" "}
                — Detects local imports. Uses project bundle when dependencies exist, standalone script otherwise.
              </li>
              <li>
                <code className="rounded bg-[var(--surface-secondary)] px-1 py-0.5 text-[11px] font-mono">script</code>{" "}
                — Always sends individual test scripts. Fastest for self-contained specs.
              </li>
              <li>
                <code className="rounded bg-[var(--surface-secondary)] px-1 py-0.5 text-[11px] font-mono">project</code>{" "}
                — Always bundles the full project. Required when tests use shared fixtures, helpers, or configs.
              </li>
            </ul>
          </div>
        </Card>

        {/* ── API Reference ─────────────────────────────────── */}
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">REST API Reference</h3>
          <p className="text-xs text-[var(--muted)]">
            For advanced integrations, call the execution API directly.
            All endpoints require the <code className="rounded bg-[var(--surface-secondary)] px-1 py-0.5 text-[11px] font-mono">x-api-key</code> header.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">POST /api/runs</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Submit a new execution run with jobs</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">POST /api/runs/:id/jobs</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Append additional jobs to a running run</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">GET /api/runs/:id</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Get run status, progress, and metrics</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">GET /api/runs/:id/jobs</code>
              <p className="mt-1 text-xs text-[var(--muted)]">List all jobs and their results</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">POST /api/runs/:id/cancel</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Cancel a running execution</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">GET /api/queue/stats</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Queue depth, throughput, and scaling metrics</p>
            </div>
          </div>
        </Card>
      </div>
    </StandardPageLayout>
  );
}
