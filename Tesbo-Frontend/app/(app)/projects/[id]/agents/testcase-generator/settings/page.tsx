"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getAgentSettings, saveAgentSettings } from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function TestCaseGeneratorSettingsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [saved, setSaved] = useState(false);

  const [newJira, setNewJira] = useState(true);
  const [updatedJira, setUpdatedJira] = useState(false);
  const [newKb, setNewKb] = useState(true);
  const [updatedKb, setUpdatedKb] = useState(false);
  const [autoRunOnTrigger, setAutoRunOnTrigger] = useState(true);
  const [generatedCaseCount, setGeneratedCaseCount] = useState(5);
  const [autoCommentOnJira, setAutoCommentOnJira] = useState(false);

  useEffect(() => {
    const current = getAgentSettings(projectId, "testcase_generator");
    setNewJira(current.autoGenerateOnNewJiraTickets !== false);
    setUpdatedJira(Boolean(current.autoGenerateOnUpdatedJiraTickets));
    setNewKb(current.autoGenerateOnNewKnowledgeBase !== false);
    setUpdatedKb(Boolean(current.autoGenerateOnUpdatedKnowledgeBase));
    setAutoRunOnTrigger(current.autoRunOnTrigger !== false);
    setGeneratedCaseCount(Math.max(1, Math.min(15, Number(current.generatedTestcaseCount || 5))));
    setAutoCommentOnJira(Boolean(current.autoCommentOnJira));
  }, [projectId]);

  const onSave = () => {
    const base = getAgentSettings(projectId, "testcase_generator");
    saveAgentSettings(projectId, "testcase_generator", {
      ...base,
      autoGenerateOnNewJiraTickets: newJira,
      autoGenerateOnUpdatedJiraTickets: updatedJira,
      autoGenerateOnNewKnowledgeBase: newKb,
      autoGenerateOnUpdatedKnowledgeBase: updatedKb,
      autoRunOnTrigger,
      generatedTestcaseCount: generatedCaseCount,
      autoCommentOnJira,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const breadcrumb = (
    <Link href={`/projects/${projectId}/agents/testcase-generator`} className="inline-flex items-center gap-1 text-[var(--muted)] hover:text-[var(--brand-primary)]">
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      Back to Test Case Generator
    </Link>
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Test Case Generator Settings"
          subtitle="Define when this agent detects changes and generates test cases."
          breadcrumb={breadcrumb}
        />
      }
      className="flex-1 p-6 md:p-10 max-w-4xl mx-auto w-full"
    >
      <Card className="p-6 space-y-5">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Trigger Rules</h2>
        <p className="text-sm text-[var(--muted)]">
          Configure automated triggers for Jira and Knowledge Base changes.
        </p>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={newJira}
            onChange={(e) => setNewJira(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Generate when new Jira ticket is created</p>
            <p className="text-xs text-[var(--muted)] mt-1">Queues generation for newly synced Jira issues.</p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={updatedJira}
            onChange={(e) => setUpdatedJira(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Generate when Jira ticket is updated</p>
            <p className="text-xs text-[var(--muted)] mt-1">Creates revised test case drafts for Jira updates.</p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={newKb}
            onChange={(e) => setNewKb(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Generate when new Knowledge Base item is created</p>
            <p className="text-xs text-[var(--muted)] mt-1">Queues generation for new notes and uploaded documents.</p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={updatedKb}
            onChange={(e) => setUpdatedKb(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Generate when Knowledge Base item is updated</p>
            <p className="text-xs text-[var(--muted)] mt-1">Creates revised drafts when requirements or docs change.</p>
          </div>
        </label>
      </Card>

      <Card className="p-6 space-y-5">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Generation Behavior</h2>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={autoRunOnTrigger}
            onChange={(e) => setAutoRunOnTrigger(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Auto-run generation after trigger scan</p>
            <p className="text-xs text-[var(--muted)] mt-1">If disabled, items will be queued and wait for manual run.</p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-4 cursor-pointer hover:border-[var(--brand-primary)]/50 transition-colors">
          <input
            type="checkbox"
            className="mt-1 rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            checked={autoCommentOnJira}
            onChange={(e) => setAutoCommentOnJira(e.target.checked)}
          />
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Comment on Jira when approved cases are stored</p>
            <p className="text-xs text-[var(--muted)] mt-1">Posts created test cases back to the linked Jira issue.</p>
          </div>
        </label>

        <Field>
          <FieldLabel>Generated test cases per task</FieldLabel>
          <Input
            type="number"
            min={1}
            max={15}
            value={generatedCaseCount}
            onChange={(e) => setGeneratedCaseCount(Math.max(1, Math.min(15, Number(e.target.value) || 1)))}
            className="w-28"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">Recommended: 3-7 for high-quality review cycles.</p>
        </Field>
      </Card>

      <Card className="p-6">
        <h2 className="text-base font-semibold text-[var(--foreground)] mb-2">Lifecycle</h2>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Trigger detected or user request -&gt; generation queued -&gt; agent generates drafts -&gt; reviewer approves -&gt;
          approved test cases are saved into repository. Revisions and rejections stay visible in the same lifecycle view.
        </p>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={onSave}>Save Settings</Button>
        {saved && <span className="text-sm text-[var(--success)]">Settings saved</span>}
      </div>
    </StandardPageLayout>
  );
}
