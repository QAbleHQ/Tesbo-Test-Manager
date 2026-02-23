"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  authMe,
  getTestCase,
  startAutomationSession,
  sendAutomationCommand,
  getAutomationSession,
  getAutomationStreamState,
  finalizeAutomationSession,
  cancelAutomationSession,
  type AutomationSession,
} from "@/lib/api";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default function AutomateTestCasePage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const testcaseId = params.tcId as string;

  const [testcaseTitle, setTestcaseTitle] = useState("Test Case");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<AutomationSession | null>(null);
  const [command, setCommand] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [streamState, setStreamState] = useState<"Connecting" | "Live" | "Lagging" | "Disconnected">("Connecting");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getTestCase(projectId, testcaseId)
        .then((tc) => setTestcaseTitle((tc.title as string) || "Generated Test"))
        .catch(() => {});
      startAutomationSession(projectId, testcaseId)
        .then((created) => {
          setSessionId(created.id);
          setMessages([
            {
              role: "assistant",
              content: "Automation session started. Enter a command and I will execute it in the visible browser pane.",
            },
          ]);
        })
        .catch((error: unknown) => {
          setMessages([
            {
              role: "assistant",
              content: error instanceof Error ? error.message : "Failed to start automation session.",
            },
          ]);
        });
    });
  }, [projectId, testcaseId, router]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [sessionResponse, streamResponse] = await Promise.all([
          getAutomationSession(projectId, sessionId),
          getAutomationStreamState(projectId, sessionId),
        ]);
        if (cancelled) return;
        setSession(sessionResponse);
        const encodedScreenshot = typeof streamResponse.screenshotDataUrl === "string" ? streamResponse.screenshotDataUrl : null;
        setScreenshotDataUrl(encodedScreenshot);
        setStreamState("Live");
      } catch {
        if (!cancelled) {
          setStreamState((prev) => (prev === "Disconnected" ? "Disconnected" : "Lagging"));
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, sessionId]);

  const timeline = useMemo(() => {
    if (!session?.events) return [];
    return session.events.slice(-20);
  }, [session?.events]);

  async function onSendCommand() {
    if (!sessionId || !command.trim() || sending) return;
    const value = command.trim();
    setCommand("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: value }]);
    try {
      const response = await sendAutomationCommand(projectId, sessionId, value);
      if (response.requiresClarification) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: response.clarificationQuestion || "Please clarify your command." },
        ]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: "Command executed. Review the browser pane and timeline." }]);
      }
      setStreamState("Live");
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Failed to execute command." },
      ]);
      setStreamState("Lagging");
    } finally {
      setSending(false);
    }
  }

  async function onFinalize() {
    if (!sessionId || finalizing) return;
    setFinalizing(true);
    try {
      await finalizeAutomationSession(projectId, sessionId, {
        framework: "Playwright",
        testName: testcaseTitle,
      });
      router.push(`/projects/${projectId}/testcases/${testcaseId}`);
      router.refresh();
    } finally {
      setFinalizing(false);
    }
  }

  async function onCancelSession() {
    if (!sessionId) {
      router.push(`/projects/${projectId}/testcases/${testcaseId}`);
      return;
    }
    await cancelAutomationSession(projectId, sessionId);
    router.push(`/projects/${projectId}/testcases/${testcaseId}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/projects/${projectId}/testcases/${testcaseId}`} className="text-sm text-blue-600 hover:underline">
            Back to Test Case
          </Link>
          <span className="text-zinc-400">/</span>
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Automate: {testcaseTitle}</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">{streamState}</span>
          <button
            type="button"
            onClick={onFinalize}
            disabled={!sessionId || finalizing || streamState === "Disconnected"}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {finalizing ? "Saving..." : "Save Script"}
          </button>
          <button
            type="button"
            onClick={onCancelSession}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Cancel
          </button>
        </div>
      </header>

      <main className="grid gap-4 p-4 lg:grid-cols-2">
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Automation Chat</h2>
          <div className="mb-3 h-[420px] overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950">
            <div className="space-y-3">
              {messages.map((message, idx) => (
                <div
                  key={idx}
                  className={`rounded p-2 text-sm ${
                    message.role === "user"
                      ? "ml-10 bg-blue-600 text-white"
                      : "mr-10 bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  }`}
                >
                  {message.content}
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Enter automation command..."
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={() => void onSendCommand()}
              disabled={sending || !sessionId}
              className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {sending ? "Running..." : "Run"}
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Live Browser</h2>
          <div className="mb-3 flex h-[320px] items-center justify-center rounded border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950">
            {screenshotDataUrl ? (
              // Screenshot fallback is used for MVP live visibility.
              <img src={screenshotDataUrl} alt="Live browser snapshot" className="h-full w-full object-contain" />
            ) : (
              <p className="text-sm text-zinc-500">Waiting for first browser snapshot...</p>
            )}
          </div>
          <p className="mb-3 text-xs text-zinc-500">
            Current URL: {session?.currentUrl || "-"}
          </p>
          <div className="h-[160px] overflow-auto rounded border border-zinc-200 p-2 text-xs dark:border-zinc-700">
            <p className="mb-2 font-medium">Recent Step Events</p>
            <div className="space-y-1">
              {timeline.map((event) => (
                <div key={event.id} className="rounded bg-zinc-50 px-2 py-1 dark:bg-zinc-800">
                  <span className="font-semibold">{event.eventType}</span>
                  {event.rawCommand ? ` - ${event.rawCommand}` : ""}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
