"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function TesboSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    if (projectId) {
      router.replace(`/projects/${projectId}/settings`);
    }
  }, [projectId, router]);

  return (
    <main className="max-w-3xl mx-auto px-6 py-8">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">Opening project settings…</p>
    </main>
  );
}
