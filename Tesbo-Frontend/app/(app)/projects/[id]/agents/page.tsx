"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function AgentsPage() {
  const params = useParams();
  const projectId = params.id as string;

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Agents Control Center"
          subtitle="Operate generation, automation, review, and approvals with a shared lifecycle."
        />
      }
    >
      <div className="mx-auto grid w-full max-w-6xl gap-4 md:grid-cols-3">
        <Card className="rounded-2xl border border-[var(--border)] p-6">
          <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-soft)] text-[var(--brand-primary)]">
            <span className="text-lg">A</span>
          </div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Aegis</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
            Runs browser automation and generates scripts for review.
          </p>
          <div className="mt-5 flex gap-2">
            <Link href={`/projects/${projectId}/agents/aegis`}>
              <Button>Open Aegis</Button>
            </Link>
            <Link href={`/projects/${projectId}/agents/aegis/settings`}>
              <Button variant="secondary">Settings</Button>
            </Link>
          </div>
        </Card>

        <Card className="rounded-2xl border border-[var(--border)] p-6">
          <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--ai-soft)] text-[var(--ai-primary)]">
            <span className="text-lg">S</span>
          </div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Sentinel</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
            Reviews generated scripts and enforces quality gates.
          </p>
          <div className="mt-5 flex gap-2">
            <Link href={`/projects/${projectId}/agents/sentinel`}>
              <Button>Open Sentinel</Button>
            </Link>
            <Link href={`/projects/${projectId}/agents/sentinel/settings`}>
              <Button variant="secondary">Settings</Button>
            </Link>
          </div>
        </Card>

        <Card className="rounded-2xl border border-[var(--border)] p-6">
          <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--ai-soft)] text-[var(--ai-primary)]">
            <span className="text-lg">T</span>
          </div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Test Case Generator</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
            Generates test cases from Jira and Knowledge Base, then routes through review and approval.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={`/projects/${projectId}/agents/testcase-generator`}>
              <Button>Open Generator Agent</Button>
            </Link>
            <Link href={`/projects/${projectId}/agents/testcase-generator/settings`}>
              <Button variant="secondary">Settings</Button>
            </Link>
            <Link href={`/projects/${projectId}/ai-test-script`}>
              <Button variant="secondary">Manual AI Generation</Button>
            </Link>
          </div>
        </Card>
      </div>
    </StandardPageLayout>
  );
}
