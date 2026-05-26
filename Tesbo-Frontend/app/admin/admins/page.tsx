"use client";

import { useEffect, useState } from "react";
import {
  authMe,
  getAdminList,
  addPlatformAdmin,
  removePlatformAdmin,
} from "@/lib/api";

type PlatformAdmin = {
  id: string;
  userId: string;
  role: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  grantedBy?: {
    email: string;
    name: string;
  };
};

export default function ManageAdminsPage() {
  const [admins, setAdmins] = useState<PlatformAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const [email, setEmail] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([authMe(), getAdminList()])
      .then(([me, list]) => {
        if (me) {
          const currentAdmin = list.find(
            (a: PlatformAdmin) => a.userId === me.userId
          );
          setIsOwner(currentAdmin?.role === "owner");
        }
        setAdmins(list);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleAdd = async () => {
    if (!email.trim()) return;
    setAdding(true);
    setAddError(null);
    setAddSuccess(null);

    try {
      await addPlatformAdmin(email.trim());
      setAddSuccess(`${email.trim()} added as platform admin`);
      setEmail("");
      const list = await getAdminList();
      setAdmins(list);
    } catch (e) {
      setAddError(
        e instanceof Error ? e.message : "Failed to add admin"
      );
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (adminId: string) => {
    setRemovingId(adminId);
    try {
      await removePlatformAdmin(adminId);
      setAdmins((prev) => prev.filter((a) => a.id !== adminId));
    } catch {
      // silently fail for now
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--foreground)]">
            Manage Admins
          </h1>
          <p className="mt-1 text-[15px] text-[var(--muted)]">Loading...</p>
        </div>
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-[72px] animate-pulse rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)]"
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
          Manage Admins
        </h1>
        <p className="mt-1 text-[15px] text-[var(--muted)]">
          Platform administrators who can access this admin panel
        </p>
      </div>

      {/* Add admin form (owner only) */}
      {isOwner && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
          <h2 className="text-[16px] font-semibold text-[var(--foreground)] mb-3">
            Add Platform Admin
          </h2>
          <div className="flex items-center gap-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="Enter user email address"
              className="flex-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-2.5 text-[14px] text-[var(--foreground)] placeholder:text-[var(--muted-soft)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding || !email.trim()}
              className="rounded-xl bg-[var(--brand-primary)] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[var(--brand-hover)] transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              {adding ? "Adding..." : "Add Admin"}
            </button>
          </div>
          {addError && (
            <p className="mt-2 text-[13px] text-[var(--error)]">{addError}</p>
          )}
          {addSuccess && (
            <p className="mt-2 text-[13px] text-[var(--success)]">
              {addSuccess}
            </p>
          )}
          <p className="mt-2 text-[12px] text-[var(--muted)]">
            The user must already have a Tesbo account. Admins can view all
            platform data. Only owners can manage other admins.
          </p>
        </div>
      )}

      {/* Admins list */}
      <div className="space-y-3">
        {admins.map((admin) => (
          <div
            key={admin.id}
            className="flex items-center justify-between rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] px-5 py-4"
          >
            <div className="flex items-center gap-4">
              {/* Avatar */}
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-tertiary)] text-[14px] font-bold text-[var(--muted)]">
                {admin.name
                  ? admin.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()
                  : admin.email[0].toUpperCase()}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-[var(--foreground)]">
                    {admin.name || admin.email.split("@")[0]}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                      admin.role === "owner"
                        ? "bg-[var(--ai-soft)] text-[var(--ai-primary)]"
                        : "bg-[var(--brand-soft)] text-[var(--brand-primary)]"
                    }`}
                  >
                    {admin.role}
                  </span>
                </div>
                <p className="text-[13px] text-[var(--muted)]">
                  {admin.email}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right">
                {admin.grantedBy && (
                  <p className="text-[12px] text-[var(--muted)]">
                    Added by {admin.grantedBy.name || admin.grantedBy.email}
                  </p>
                )}
                <p className="text-[12px] text-[var(--muted)]">
                  {new Date(admin.createdAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>

              {isOwner && admin.role !== "owner" && (
                <button
                  type="button"
                  onClick={() => handleRemove(admin.id)}
                  disabled={removingId === admin.id}
                  className="rounded-xl border border-[var(--error)]/30 px-3 py-1.5 text-[13px] font-semibold text-[var(--error)] hover:bg-[var(--error-soft)] transition-colors disabled:opacity-60"
                >
                  {removingId === admin.id ? "Removing..." : "Remove"}
                </button>
              )}
            </div>
          </div>
        ))}

        {admins.length === 0 && (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] px-5 py-12 text-center text-[15px] text-[var(--muted)]">
            No platform admins configured
          </div>
        )}
      </div>
    </div>
  );
}
