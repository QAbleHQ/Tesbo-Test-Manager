"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authMe } from "@/lib/api";

export default function WorkspaceIntegrationsPage() {
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
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Integrations</h1>
      <p className="mt-2 text-zinc-500">Connect external tools and services to your workspace.</p>
    </main>
  );
}
