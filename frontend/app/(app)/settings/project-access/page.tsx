"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function WorkspaceProjectAccessPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings/members");
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-zinc-500">Redirecting to workspace members…</p>
    </div>
  );
}
