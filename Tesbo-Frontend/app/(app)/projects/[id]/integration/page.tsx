"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { authMe, getProject } from "@/lib/api";
import { Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">{lang}</span>
        <button
          type="button"
          onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="rounded px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)] transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-[var(--foreground)]"><code>{code}</code></pre>
    </div>
  );
}

function StepCard({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ai-surface)] text-sm font-bold text-[var(--ai-primary)]">
        {step}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold text-[var(--foreground)]">{title}</h3>
        <div className="mt-3 space-y-3">{children}</div>
      </div>
    </div>
  );
}

export default function IntegrationPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) { router.replace("/login"); return; }
      getProject(projectId)
        .then((p) => setProject(p))
        .catch(() => router.replace("/projects"))
        .finally(() => setLoading(false));
    });
  }, [projectId, router]);

  if (loading || !project) {
    return <div className="flex min-h-screen items-center justify-center"><p className="text-[var(--muted)]">Loading…</p></div>;
  }

  const apiBase = "https://executions.tesbox.io";

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Integration Guide"
          subtitle="Run your Playwright tests on TesboX-Executions infrastructure from local dev or CI/CD."
        />
      }
    >
      <div className="mx-auto max-w-3xl space-y-8">
        <Card className="border-l-[3px] border-l-[var(--ai-primary)] p-5">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ai-primary)]" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 5v14l11-7-11-7z" /></svg>
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">How it works</p>
              <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
                The <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">@tesbox/cli</code> reads
                your Playwright spec files, sends them to TesboX-Executions, and waits for results.
                TesboX-Executions handles browser provisioning, parallel execution, retries, and artifact collection
                on its own infrastructure — your CI runner never needs a browser installed.
              </p>
            </div>
          </div>
        </Card>

        <div className="space-y-8">
          <StepCard step={1} title="Get your API key">
            <p className="text-sm text-[var(--muted)]">
              Your API key authenticates requests to TesboX-Executions.
              Go to <span className="font-medium text-[var(--foreground)]">Settings → API Keys</span> to generate one.
            </p>
            <CodeBlock lang="env" code={`TESBOX_API_KEY=txe_your_api_key_here\nTESBOX_PROJECT_ID=${projectId}`} />
          </StepCard>

          <StepCard step={2} title="Install the CLI">
            <p className="text-sm text-[var(--muted)]">
              Add the TesboX CLI as a dev dependency in your project.
            </p>
            <CodeBlock lang="bash" code="npm install -D @tesbox/cli" />
          </StepCard>

          <StepCard step={3} title="Run tests locally">
            <p className="text-sm text-[var(--muted)]">
              Point the CLI at your spec files. Each <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">.spec.ts</code> file
              becomes a job that runs in an isolated browser on TesboX infrastructure.
            </p>
            <CodeBlock lang="bash" code={`npx tesbox run "tests/**/*.spec.ts" \\
  --api-key txe_your_api_key_here \\
  --project-id ${projectId} \\
  --max-parallel 4 \\
  --start-url https://staging.example.com`} />
            <p className="text-sm text-[var(--muted)]">
              Or use environment variables so you don't need flags every time:
            </p>
            <CodeBlock lang="bash" code={`export TESBOX_API_KEY=txe_your_api_key_here
export TESBOX_PROJECT_ID=${projectId}

npx tesbox run "tests/**/*.spec.ts" --max-parallel 4`} />
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3">
              <p className="text-xs font-semibold text-[var(--foreground)]">Example output</p>
              <pre className="mt-2 text-xs leading-relaxed text-[var(--muted)] font-mono whitespace-pre">{`  Discovering tests matching: tests/**/*.spec.ts

  Found 3 spec files:
    tests/login.spec.ts
    tests/checkout.spec.ts
    tests/dashboard.spec.ts

  Submitting 3 jobs to ${apiBase}...

  Run created: a1b2c3d4-...
  Total jobs: 3 | Max parallel: 4
  Waiting for results...

  Status: running | Passed: 1/3 | Failed: 0 | Queued: 2
  Status: running | Passed: 2/3 | Failed: 0 | Queued: 1
  Status: completed | Passed: 3/3 | Failed: 0 | Queued: 0

  ─────────────────────────────────────────────────────
  Test Results
  ─────────────────────────────────────────────────────

  Spec                       Status     Duration
  ─────────────────────────  ─────────  ──────────
  tests/login.spec.ts         passed    3.2s
  tests/checkout.spec.ts      passed    5.1s
  tests/dashboard.spec.ts     passed    2.8s

  All 3 tests passed (11.1s)`}</pre>
            </div>
          </StepCard>

          <StepCard step={4} title="Add to GitHub Actions">
            <p className="text-sm text-[var(--muted)]">
              Add one step to your workflow. No browser installation needed in CI — tests run on TesboX infrastructure.
            </p>
            <CodeBlock lang="yaml" code={`# .github/workflows/test.yml
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

      - name: Run tests on TesboX-Executions
        run: npx tesbox run "tests/**/*.spec.ts" --max-parallel 4
        env:
          TESBOX_API_KEY: \${{ secrets.TESBOX_API_KEY }}
          TESBOX_PROJECT_ID: ${projectId}`} />
            <p className="text-sm text-[var(--muted)]">
              Add <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 text-xs font-mono">TESBOX_API_KEY</code> to
              your repository secrets in GitHub → Settings → Secrets and variables → Actions.
            </p>
          </StepCard>

          <StepCard step={5} title="View results">
            <p className="text-sm text-[var(--muted)]">
              Test results appear in the <span className="font-medium text-[var(--foreground)]">Automation Runs</span> section
              in the sidebar. You can view per-spec results, logs, screenshots, and traces for every run.
            </p>
          </StepCard>
        </div>

        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">CLI Reference</h3>
          <CodeBlock lang="bash" code={`tesbox run <glob> [options]

Options:
  --api-key <key>        API key (or TESBOX_API_KEY env)
  --project-id <id>      Project ID (or TESBOX_PROJECT_ID env)
  --api-url <url>        API URL (default: ${apiBase})
  --max-parallel <n>     Parallel browsers (default: 4)
  --start-url <url>      Base URL for tests
  --poll-interval <ms>   Poll interval in ms (default: 5000)`} />
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">API Reference</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">For advanced integrations, you can call the REST API directly.</p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">POST /api/runs</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Submit a new test execution run</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">GET /api/runs/:id</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Get run status and progress</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">GET /api/runs/:id/jobs</code>
              <p className="mt-1 text-xs text-[var(--muted)]">List jobs in a run</p>
            </div>
            <div className="rounded-lg border border-[var(--border-subtle)] p-3">
              <code className="text-xs font-mono text-[var(--ai-primary)]">POST /api/runs/:id/cancel</code>
              <p className="mt-1 text-xs text-[var(--muted)]">Cancel a running execution</p>
            </div>
          </div>
        </Card>
      </div>
    </StandardPageLayout>
  );
}
