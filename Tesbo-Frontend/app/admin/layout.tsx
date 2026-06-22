"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authMe } from "@/lib/api";
import Sidebar from "@/components/Sidebar";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let active = true;
    authMe().then((data) => {
      if (!active) return;
      if (!data || !data.isPlatformAdmin) {
        router.replace("/projects");
        return;
      }
      setAuthorized(true);
    });
    return () => {
      active = false;
    };
  }, [router]);

  if (!authorized) {
    return (
      <div className="tesbo-app-shell flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-[var(--muted)]">
          <svg
            className="h-5 w-5 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <span className="text-[15px] font-medium">Verifying access...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tesbo-app-shell flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="tesbo-page">{children}</div>
      </main>
    </div>
  );
}
