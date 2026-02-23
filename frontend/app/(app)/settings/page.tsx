"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authMe } from "@/lib/api";

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const [auth, setAuth] = useState<{ userId: string } | null>(null);

  useEffect(() => {
    authMe().then((me) => {
      setAuth(me);
      if (!me) router.replace("/login");
    });
  }, [router]);

  if (!auth) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Workspace settings</h1>
      <p className="mt-2 text-zinc-500">Manage your workspace, team invitations, and project access controls.</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <a
          href="/settings/members"
          className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 hover:border-blue-300 dark:hover:border-blue-600"
        >
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Members & invites</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Invite teammates by email and manage pending workspace invitations.
          </p>
        </a>
        <a
          href="/settings/project-access"
          className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 hover:border-blue-300 dark:hover:border-blue-600"
        >
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Project access</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Assign which workspace members can access each project and set their project role.
          </p>
        </a>
      </div>
    </main>
  );
}
