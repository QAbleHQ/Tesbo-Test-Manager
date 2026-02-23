"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  acceptInvitation,
  authMe,
  getInvitationByToken,
  type InviteDetails,
} from "@/lib/api";

export default function InviteAcceptancePage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [auth, setAuth] = useState<{ userId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([getInvitationByToken(token), authMe()])
      .then(([inv, me]) => {
        if (!active) return;
        setInvite(inv);
        setAuth(me);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load invitation");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  async function onAccept() {
    setError("");
    setAccepting(true);
    try {
      await acceptInvitation(token);
      router.push("/projects");
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to accept invitation";
      setError(message);
      if (message.toLowerCase().includes("not authenticated")) {
        router.push(`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`);
      }
    } finally {
      setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading invitation…</p>
      </div>
    );
  }

  if (error && !invite) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Invitation unavailable</h1>
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  const isPending = invite?.status === "pending";
  const invitePath = `/invite/${token}`;
  const loginUrl = `/login?redirect=${encodeURIComponent(invitePath)}&inviteEmail=${encodeURIComponent(
    invite?.email ?? ""
  )}`;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Workspace invitation</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          {invite?.email} is invited to join{" "}
          <span className="font-medium">{invite?.organizationName ?? "this workspace"}</span>.
        </p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400 capitalize">
          Role: {invite?.role} · Status: {invite?.status}
        </p>

        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {!isPending && (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            This invitation can no longer be accepted.
          </p>
        )}

        {isPending && !auth && (
          <div className="mt-5">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              Sign in with the invited email address to accept.
            </p>
            <Link
              href={loginUrl}
              className="mt-3 inline-block rounded-lg bg-zinc-900 text-white py-2 px-4 text-sm font-semibold hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-offset-zinc-900"
            >
              Continue to sign in
            </Link>
          </div>
        )}

        {isPending && auth && (
          <button
            type="button"
            onClick={onAccept}
            disabled={accepting}
            className="mt-5 rounded-lg bg-blue-600 text-white py-2 px-4 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {accepting ? "Joining…" : "Accept and join workspace"}
          </button>
        )}
      </div>
    </div>
  );
}
