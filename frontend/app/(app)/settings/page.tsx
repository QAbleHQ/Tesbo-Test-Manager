"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authMe } from "@/lib/api";
import { StandardPageLayout, PageHeader } from "@/components/workflows";

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const [auth, setAuth] = useState<{ userId: string } | null>(null);

  useEffect(() => {
    authMe().then((me) => {
      setAuth(me);
      if (!me) router.replace("/login");
      else router.replace("/settings/members");
    });
  }, [router]);

  if (!auth) {
    return (
      <StandardPageLayout header={<PageHeader title="Settings" />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout header={<PageHeader title="Settings" />}>
      <div className="flex min-h-[200px] items-center justify-center">
        <p className="text-[var(--muted)]">Redirecting to workspace members…</p>
      </div>
    </StandardPageLayout>
  );
}
