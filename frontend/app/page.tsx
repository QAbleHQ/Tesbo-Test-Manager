"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authMe } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    authMe().then((me) => {
      if (me) router.replace("/projects");
      else router.replace("/login");
    });
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] dark:bg-zinc-950">
      <p className="text-[var(--muted)]">Redirecting…</p>
    </div>
  );
}
