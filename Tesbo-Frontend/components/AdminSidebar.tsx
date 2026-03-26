"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { logout } from "@/lib/api";

type AdminNavItem = {
  href: string;
  label: string;
  icon: AdminIconName;
};

const adminNavItems: AdminNavItem[] = [
  { href: "/admin", label: "System Health", icon: "heartPulse" },
  { href: "/admin/customers", label: "Customers", icon: "buildings" },
  { href: "/admin/admins", label: "Manage Admins", icon: "shield" },
];

type AdminIconName =
  | "heartPulse"
  | "buildings"
  | "shield"
  | "arrowLeft"
  | "logout"
  | "chevronLeft"
  | "chevronRight"
  | "admin";

function AdminIcon({
  name,
  className = "h-[18px] w-[18px]",
}: {
  name: AdminIconName;
  className?: string;
}) {
  const common = {
    className,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    viewBox: "0 0 24 24",
  } as const;
  switch (name) {
    case "heartPulse":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 12h4l2-5 4 10 2-5h6"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6c-1.5-2-4-3-6-1.5S3 9 6 12l6 6 6-6c3-3 2.5-6 .5-7.5S13.5 4 12 6z"
          />
        </svg>
      );
    case "buildings":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 21h18M9 8h1M9 12h1M9 16h1M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M15 11h4a2 2 0 0 1 2 2v8"
          />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12l2 2 4-4"
          />
        </svg>
      );
    case "arrowLeft":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 12H5M12 19l-7-7 7-7"
          />
        </svg>
      );
    case "logout":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
          />
        </svg>
      );
    case "chevronLeft":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 18l-6-6 6-6"
          />
        </svg>
      );
    case "chevronRight":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 18l6-6-6-6"
          />
        </svg>
      );
    case "admin":
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.7.7V20a2 2 0 1 1-4 0v-.1a1 1 0 0 0-1.7-.7l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0-.7-1.7H4a2 2 0 1 1 0-4h.1a1 1 0 0 0 .7-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.7-.7V4a2 2 0 1 1 4 0v.1a1 1 0 0 0 1.7.7l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0 .7 1.7H20a2 2 0 1 1 0 4h-.1a1 1 0 0 0-.7 1.7z"
          />
        </svg>
      );
    default:
      return null;
  }
}

export default function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const isPathActive = (href: string) => {
    if (!pathname) return false;
    if (href === "/admin") return pathname === "/admin";
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const onLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await logout();
      if (typeof window !== "undefined") localStorage.removeItem("token");
      router.replace("/login");
      router.refresh();
    } catch {
      setIsLoggingOut(false);
    }
  };

  return (
    <aside
      className={`sticky top-0 shrink-0 flex h-screen flex-col bg-[var(--app-shell)] border-r border-[var(--border-subtle)] transition-[width] duration-200 ${
        isCollapsed ? "w-[68px]" : "w-[256px]"
      }`}
    >
      {/* Header */}
      <div className="flex h-14 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3">
        <Link
          href="/admin"
          className={`flex items-center gap-2 ${isCollapsed ? "justify-center" : ""}`}
          aria-label="TesboX Admin"
        >
          {isCollapsed ? (
            <span className="text-base font-bold text-[var(--brand-primary)]">
              TA
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <AdminIcon
                name="admin"
                className="h-5 w-5 text-[var(--brand-primary)]"
              />
              <span className="text-[15px] font-bold text-[var(--foreground)]">
                TesboX Admin
              </span>
            </div>
          )}
        </Link>
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          className="rounded-lg p-1.5 text-[var(--muted-soft)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)] transition-colors"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <AdminIcon
            name={isCollapsed ? "chevronRight" : "chevronLeft"}
            className="h-4 w-4"
          />
        </button>
      </div>

      {/* Admin badge */}
      {!isCollapsed && (
        <div className="border-b border-[var(--border-subtle)] px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--ai-surface)] px-3 py-1.5">
            <span className="h-2 w-2 rounded-full bg-[var(--ai-primary)]" />
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--ai-primary)]">
              Platform Admin
            </span>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-3 space-y-0.5">
        {adminNavItems.map(({ href, label, icon }) => {
          const active = isPathActive(href);
          return (
            <Link
              key={href}
              href={href}
              title={isCollapsed ? label : undefined}
              aria-label={label}
              className={`group relative flex items-center overflow-hidden rounded-lg py-2 text-[15px] font-semibold transition-colors duration-150 ${
                isCollapsed
                  ? "justify-center px-2"
                  : "gap-2.5 pl-5 pr-3.5"
              } ${
                active
                  ? "bg-[var(--brand-surface)] text-[var(--foreground)] font-medium"
                  : "text-[var(--muted)] hover:bg-[var(--surface)]/70 hover:text-[var(--foreground)]"
              }`}
            >
              {active && (
                <span
                  className="absolute inset-y-1 left-0 w-[3px] rounded-r-full bg-[var(--brand-primary)]"
                  aria-hidden
                />
              )}
              <AdminIcon
                name={icon}
                className={`h-[18px] w-[18px] shrink-0 ${
                  active
                    ? "text-[var(--brand-primary)]"
                    : "text-[var(--muted-soft)]"
                }`}
              />
              {isCollapsed ? (
                <span className="sr-only">{label}</span>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--border-subtle)] p-2 space-y-1">
        <Link
          href="/projects"
          className={`w-full rounded-lg py-2 text-[14px] text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)] transition-colors ${
            isCollapsed
              ? "flex justify-center px-2"
              : "flex items-center gap-2.5 px-2.5"
          }`}
          aria-label="Back to Workspace"
        >
          <AdminIcon
            name="arrowLeft"
            className="h-[18px] w-[18px] shrink-0 text-[var(--muted-soft)]"
          />
          {isCollapsed ? (
            <span className="sr-only">Back to Workspace</span>
          ) : (
            <span>Back to Workspace</span>
          )}
        </Link>

        <button
          type="button"
          onClick={onLogout}
          disabled={isLoggingOut}
          className={`w-full rounded-lg py-2 text-[14px] text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)] transition-colors disabled:opacity-60 ${
            isCollapsed
              ? "flex justify-center px-2"
              : "flex items-center gap-2.5 px-2.5 text-left"
          }`}
          aria-label={isLoggingOut ? "Logging out" : "Log out"}
        >
          <AdminIcon
            name="logout"
            className="h-[18px] w-[18px] shrink-0 text-[var(--muted-soft)]"
          />
          {isCollapsed ? (
            <span className="sr-only">
              {isLoggingOut ? "Logging out..." : "Log out"}
            </span>
          ) : (
            <span>{isLoggingOut ? "Logging out..." : "Log out"}</span>
          )}
        </button>
      </div>
    </aside>
  );
}
