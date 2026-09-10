"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout as logoutRequest } from "@/lib/api";
import { removeStoredValue } from "@/lib/storage";
import { clearPageCache } from "@/lib/pageDataCache";

/**
 * The one place that calls POST /api/auth/logout and clears client-side state afterward — shared by
 * the sidebar footer's logout button and the top-bar user menu, so there is a single logout flow
 * instead of two copies that could drift apart.
 */
export function useLogout() {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logout = async () => {
    if (isLoggingOut) return;
    setError(null);
    setIsLoggingOut(true);
    try {
      await logoutRequest();
      if (typeof window !== "undefined") removeStoredValue("token");
      clearPageCache();
      router.replace("/login");
      router.refresh();
    } catch {
      // Left in place on failure so the caller can offer a retry rather than dismissing silently.
      setError("Could not log out. Please try again.");
      setIsLoggingOut(false);
    }
  };

  const resetError = () => setError(null);

  return { isLoggingOut, error, logout, resetError };
}
