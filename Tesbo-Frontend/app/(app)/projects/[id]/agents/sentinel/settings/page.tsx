"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getAgentSettings, saveAgentSettings } from "@/lib/api";
import { Button, Card, Field, FieldLabel, Textarea } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function SentinelSettingsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [reviewBotEnabled, setReviewBotEnabled] = useState(true);
  const [autoReviewOnScriptReady, setAutoReviewOnScriptReady] = useState(false);
  const [reviewInstruction, setReviewInstruction] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = getAgentSettings(projectId, "sentinel");
    setReviewBotEnabled(s.reviewBotEnabled !== false);
    setAutoReviewOnScriptReady(Boolean(s.autoReviewOnScriptReady));
    setReviewInstruction(typeof s.reviewInstruction === "string" ? s.reviewInstruction : "");
  }, [projectId]);

  const onSave = () => {
    saveAgentSettings(projectId, "sentinel", {
      reviewBotEnabled,
      autoReviewOnScriptReady,
      reviewInstruction,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const breadcrumb = (
    <Link href={`/projects/${projectId}/agents/sentinel`} className="inline-flex items-center gap-1 text-[var(--muted)] hover:text-[var(--brand-primary)]">
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      Back to Sentinel
    </Link>
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Sentinel Settings"
          subtitle="Control when and how the Review Bot runs."
          breadcrumb={breadcrumb}
        />
      }
      className="flex-1 p-6 md:p-10 max-w-3xl mx-auto w-full"
    >
      <Card className="p-6 space-y-5">
        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={reviewBotEnabled}
            onChange={(e) => setReviewBotEnabled(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Enable Review Bot</p>
            <p className="text-xs text-[var(--muted)] mt-1">When disabled, Sentinel will not process review tasks.</p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={autoReviewOnScriptReady}
            onChange={(e) => setAutoReviewOnScriptReady(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Auto-run review on new scripts</p>
            <p className="text-xs text-[var(--muted)] mt-1">Automatically queue and run review whenever Aegis produces pending-review scripts.</p>
          </div>
        </label>

        <Field>
          <FieldLabel>Custom Review Instruction</FieldLabel>
          <Textarea
            rows={5}
            value={reviewInstruction}
            onChange={(e) => setReviewInstruction(e.target.value)}
            placeholder="Example: Prioritize security assertions, verify role-based access checks, and ensure error-state assertions are present."
            className="resize-none"
          />
        </Field>

        <div className="flex items-center gap-3">
          <Button onClick={onSave}>
            Save Settings
          </Button>
          {saved && <span className="text-sm text-[var(--success)]">Settings saved</span>}
        </div>
      </Card>
    </StandardPageLayout>
  );
}
