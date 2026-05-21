"use client";

import { useEffect, useState } from "react";
import { getAdminCustomers } from "@/lib/api";

type CustomerSummary = {
  totalOrganizations: number;
  totalMembers: number;
  totalProjects: number;
  totalTestCases: number;
};

type Customer = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
  testCaseCount: number;
  lastActivityAt: string | null;
};

type SortKey = keyof Pick<
  Customer,
  | "name"
  | "memberCount"
  | "projectCount"
  | "testCaseCount"
  | "createdAt"
>;

function StatCard({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | string;
  suffix?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] px-5 py-4">
      <p className="text-[13px] font-medium text-[var(--muted)] uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-1 text-[24px] font-bold tracking-tight text-[var(--foreground)]">
        {typeof value === "number" ? value.toLocaleString() : value}
        {suffix && (
          <span className="ml-1 text-[16px] font-medium text-[var(--muted)]">
            {suffix}
          </span>
        )}
      </p>
    </div>
  );
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "--";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRelativeDate(dateStr: string | null) {
  if (!dateStr) return "--";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

export default function CustomersPage() {
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    getAdminCustomers()
      .then((data) => {
        setSummary(data.summary);
        setCustomers(data.customers);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const sorted = [...customers].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (typeof aVal === "string" && typeof bVal === "string")
      return aVal.localeCompare(bVal) * dir;
    if (typeof aVal === "number" && typeof bVal === "number")
      return (aVal - bVal) * dir;
    return 0;
  });

  const SortHeader = ({
    label,
    field,
    align = "left",
  }: {
    label: string;
    field: SortKey;
    align?: "left" | "right";
  }) => (
    <th
      className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-[var(--muted)] cursor-pointer hover:text-[var(--foreground)] transition-colors select-none whitespace-nowrap ${
        align === "right" ? "text-right" : "text-left"
      }`}
      onClick={() => toggleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === field && (
          <span className="text-[var(--brand-primary)]">
            {sortDir === "asc" ? "\u2191" : "\u2193"}
          </span>
        )}
      </span>
    </th>
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--foreground)]">
            Customers
          </h1>
          <p className="mt-1 text-[15px] text-[var(--muted)]">Loading...</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-[80px] animate-pulse rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--foreground)]">
          Customers
        </h1>
        <p className="mt-1 text-[15px] text-[var(--muted)]">
          All organizations using the platform
        </p>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Organizations" value={summary.totalOrganizations} />
          <StatCard label="Total Members" value={summary.totalMembers} />
          <StatCard label="Projects" value={summary.totalProjects} />
          <StatCard label="Test Cases" value={summary.totalTestCases} />
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border-subtle)]">
                <SortHeader label="Organization" field="name" />
                <SortHeader label="Members" field="memberCount" align="right" />
                <SortHeader
                  label="Projects"
                  field="projectCount"
                  align="right"
                />
                <SortHeader
                  label="Test Cases"
                  field="testCaseCount"
                  align="right"
                />
                <SortHeader label="Created" field="createdAt" />
                <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Last Active
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-[15px] text-[var(--muted)]"
                  >
                    No organizations found
                  </td>
                </tr>
              ) : (
                sorted.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--surface-secondary)]/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div>
                        <span className="text-[14px] font-semibold text-[var(--foreground)]">
                          {c.name}
                        </span>
                        <span className="ml-2 text-[12px] text-[var(--muted)]">
                          /{c.slug}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-[14px] font-medium text-[var(--foreground)]">
                      {c.memberCount}
                    </td>
                    <td className="px-4 py-3 text-right text-[14px] font-medium text-[var(--foreground)]">
                      {c.projectCount}
                    </td>
                    <td className="px-4 py-3 text-right text-[14px] font-medium text-[var(--foreground)]">
                      {c.testCaseCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-[var(--muted)]">
                      {formatDate(c.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-[var(--muted)]">
                      {formatRelativeDate(c.lastActivityAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
