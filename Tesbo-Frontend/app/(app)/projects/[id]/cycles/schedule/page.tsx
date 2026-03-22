"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  authMe,
  listTestRuns,
  listTestRunSchedules,
  createTestRunSchedule,
  updateTestRunSchedule,
  deleteTestRunSchedule,
  type TestRunListItem,
  type TestRunSchedule,
} from "@/lib/api";
import { Button, Input, Card, Field, FieldLabel, Select } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export default function ScheduleRunsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [runs, setRuns] = useState<TestRunListItem[]>([]);
  const [schedules, setSchedules] = useState<TestRunSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [cycleId, setCycleId] = useState("");
  const [scheduleType, setScheduleType] = useState<"one_time" | "recurring">("one_time");
  const [runAt, setRunAt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [timezone, setTimezone] = useState("UTC");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [runList, scheduleList] = await Promise.all([
        listTestRuns(projectId),
        listTestRunSchedules(projectId),
      ]);
      setRuns(runList);
      setSchedules(scheduleList);
      if (!cycleId && runList.length > 0) {
        setCycleId(runList[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [projectId, cycleId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      load();
    });
  }, [router, load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !cycleId) return;
    setError(null);
    setSaving(true);
    try {
      await createTestRunSchedule(projectId, {
        cycleId,
        name: name.trim(),
        scheduleType,
        runAt: scheduleType === "one_time" ? new Date(runAt).toISOString() : undefined,
        intervalMinutes: scheduleType === "recurring" ? intervalMinutes : undefined,
        timezone,
        enabled: true,
      });
      setName("");
      setRunAt("");
      setIntervalMinutes(1440);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create schedule");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(item: TestRunSchedule) {
    try {
      await updateTestRunSchedule(item.id, { enabled: !item.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update schedule");
    }
  }

  async function removeSchedule(scheduleId: string) {
    try {
      await deleteTestRunSchedule(scheduleId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete schedule");
    }
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Schedule Test Run"
          subtitle="Schedule automated execution for runs that contain automated test cases only."
          actions={
            <Link
              href={`/projects/${projectId}/cycles`}
              className="inline-flex items-center justify-center h-10 rounded-xl px-4 text-sm font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-secondary)] transition-colors"
            >
              Back to Runs
            </Link>
          }
        />
      }
    >
      {error && (
        <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-4 py-2 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      <Card className="p-5">
        <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">New Schedule</h2>
        <form onSubmit={onCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field>
            <FieldLabel>Schedule Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly Smoke"
              required
            />
          </Field>
          <Field>
            <FieldLabel>Test Run</FieldLabel>
            <Select
              value={cycleId}
              onChange={(e) => setCycleId(e.target.value)}
              required
            >
              <option value="">Select a run</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            <FieldLabel>Schedule Type</FieldLabel>
            <Select
              value={scheduleType}
              onChange={(e) => setScheduleType(e.target.value as "one_time" | "recurring")}
            >
              <option value="one_time">One-time</option>
              <option value="recurring">Recurring</option>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Timezone</FieldLabel>
            <Input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </Field>
          {scheduleType === "one_time" ? (
            <div className="md:col-span-2">
              <Field>
                <FieldLabel>Run At</FieldLabel>
                <Input
                  type="datetime-local"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                  required
                />
              </Field>
            </div>
          ) : (
            <div className="md:col-span-2">
              <Field>
                <FieldLabel>Interval Minutes</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                  required
                />
              </Field>
            </div>
          )}
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Create Schedule"}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="px-5 py-3 border-b border-[var(--border-subtle)]">
          <h2 className="font-semibold text-[var(--foreground)]">Existing Schedules</h2>
        </div>
        {loading ? (
          <div className="p-5 text-sm text-[var(--muted)]">Loading...</div>
        ) : schedules.length === 0 ? (
          <div className="p-5 text-sm text-[var(--muted)]">No schedules created yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tesbo-table">
              <thead>
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Run</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Next Run</th>
                  <th className="px-4 py-3">Last Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => {
                  const run = runs.find((r) => r.id === s.cycleId);
                  return (
                    <tr key={s.id}>
                      <td className="px-4 py-3">{s.name}</td>
                      <td className="px-4 py-3">{run?.name ?? s.cycleId}</td>
                      <td className="px-4 py-3">
                        {s.scheduleType === "one_time" ? "One-time" : `Every ${s.intervalMinutes}m`}
                      </td>
                      <td className="px-4 py-3">{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}</td>
                      <td className="px-4 py-3">{s.lastStatus ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => toggleEnabled(s)}
                          >
                            {s.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => removeSchedule(s.id)}
                          >
                            Delete
                          </Button>
                        </div>
                        {s.lastError && <p className="text-xs text-[var(--error)] mt-1">{s.lastError}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </StandardPageLayout>
  );
}
