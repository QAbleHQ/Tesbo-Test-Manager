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
          title="Autonomous Agents"
          subtitle="Coming soon. For phase one, use AI-assisted Automate to execute and record browser actions."
        />
      }
    >
      <div className="mx-auto max-w-3xl">
        <Card className="rounded-2xl border border-[var(--border)] p-7 text-center">
          <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--brand-soft)] text-[var(--brand-primary)]">
            <span className="text-xl">🚀</span>
          </div>
          <h2 className="text-xl font-semibold text-[var(--foreground)]">Autonomous agents are almost ready</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
            This capability is planned for a later release. For now, launch AI-assisted automation from your test cases and let AI execute actions in the browser while recording each step.
          </p>
          <div className="mt-6 flex justify-center">
            <Link href={`/projects/${projectId}/testcases`}>
              <Button variant="primary">Go to Test Cases</Button>
            </Link>
          </div>
        </Card>
      </div>
    </StandardPageLayout>
  );
}
