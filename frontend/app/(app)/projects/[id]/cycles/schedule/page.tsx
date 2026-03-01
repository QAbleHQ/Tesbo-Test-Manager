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
    <main className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Schedule Test Run</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Schedule automated execution for runs that contain automated test cases only.
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/cycles`}
          className="rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Back to Runs
        </Link>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 mb-6">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">New Schedule</h2>
        <form onSubmit={onCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1 text-zinc-700 dark:text-zinc-300">Schedule Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly Smoke"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-sm mb-1 text-zinc-700 dark:text-zinc-300">Test Run</label>
            <select
              value={cycleId}
              onChange={(e) => setCycleId(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              required
            >
              <option value="">Select a run</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm mb-1 text-zinc-700 dark:text-zinc-300">Schedule Type</label>
            <select
              value={scheduleType}
              onChange={(e) => setScheduleType(e.target.value as "one_time" | "recurring")}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            >
              <option value="one_time">One-time</option>
              <option value="recurring">Recurring</option>
            </select>
          </div>
          <div>
            <label className="block text-sm mb-1 text-zinc-700 dark:text-zinc-300">Timezone</label>
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          {scheduleType === "one_time" ? (
            <div className="md:col-span-2">
              <label className="block text-sm mb-1 text-zinc-700 dark:text-zinc-300">Run At</label>
              <input
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                required
              />
            </div>
          ) : (
            <div className="md:col-span-2">
              <label className="block text-sm mb-1 text-zinc-700 dark:text-zinc-300">Interval Minutes</label>
              <input
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                required
              />
            </div>
          )}
          <div className="md:col-span-2 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {saving ? "Saving..." : "Create Schedule"}
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Existing Schedules</h2>
        </div>
        {loading ? (
          <div className="p-5 text-sm text-zinc-500">Loading...</div>
        ) : schedules.length === 0 ? (
          <div className="p-5 text-sm text-zinc-500">No schedules created yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-zinc-200 dark:border-zinc-700">
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
                    <tr key={s.id} className="border-b border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-3">{s.name}</td>
                      <td className="px-4 py-3">{run?.name ?? s.cycleId}</td>
                      <td className="px-4 py-3">
                        {s.scheduleType === "one_time" ? "One-time" : `Every ${s.intervalMinutes}m`}
                      </td>
                      <td className="px-4 py-3">{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}</td>
                      <td className="px-4 py-3">{s.lastStatus ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => toggleEnabled(s)}
                            className="rounded-md border border-zinc-300 dark:border-zinc-600 px-2 py-1"
                          >
                            {s.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            onClick={() => removeSchedule(s.id)}
                            className="rounded-md border border-red-300 text-red-700 dark:border-red-700 dark:text-red-300 px-2 py-1"
                          >
                            Delete
                          </button>
                        </div>
                        {s.lastError && <p className="text-xs text-red-600 mt-1">{s.lastError}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
