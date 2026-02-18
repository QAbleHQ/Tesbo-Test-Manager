"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function SuitesPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  useEffect(() => {
    if (!projectId) return;
    router.replace(`/projects/${projectId}/testcases`);
  }, [projectId, router]);

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <p className="text-zinc-500">Redirecting to Test case repository...</p>
    </main>
  );
}
