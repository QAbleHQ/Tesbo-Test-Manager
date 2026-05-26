"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authMe, getSetupStatus } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    getSetupStatus()
      .then((status) => {
        if (status.required) {
          router.replace("/setup");
          return undefined;
        }
        return authMe();
      })
      .then((me) => {
        if (me) router.replace("/projects");
        else if (me === null) router.replace("/login");
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <p className="text-[var(--muted)]">Redirecting...</p>
    </div>
  );
}
