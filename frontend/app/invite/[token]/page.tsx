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
import { Button, Card, CardBody, CardHeader, CardTitle, StatusChip } from "@/components/ui";

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
        <p className="text-[var(--muted)]">Loading invitation…</p>
      </div>
    );
  }

  if (error && !invite) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="w-full max-w-md p-6">
          <CardHeader>
            <CardTitle>Invitation unavailable</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-[var(--error)]">{error}</p>
          </CardBody>
        </Card>
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
      <Card className="w-full max-w-md p-6">
        <CardHeader>
          <CardTitle>Workspace invitation</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1">
          <p className="text-sm text-[var(--muted)]">
            {invite?.email} is invited to join{" "}
            <span className="font-medium text-[var(--foreground)]">{invite?.organizationName ?? "this workspace"}</span>.
          </p>
          <p className="flex items-center gap-2 text-sm capitalize">
            <span className="text-[var(--muted)]">Role:</span> {invite?.role}
            <span className="text-[var(--muted)]">·</span>
            <span className="text-[var(--muted)]">Status:</span>
            <StatusChip tone={isPending ? "brand" : "neutral"}>{invite?.status}</StatusChip>
          </p>

          {error && <p className="mt-3 text-sm text-[var(--error)]">{error}</p>}

          {!isPending && (
            <p className="mt-4 text-sm text-[var(--muted)]">
              This invitation can no longer be accepted.
            </p>
          )}

          {isPending && !auth && (
            <div className="mt-5">
              <p className="text-sm text-[var(--muted)]">
                Sign in with the invited email address to accept.
              </p>
              <Link href={loginUrl} className="mt-3 inline-block">
                <Button>Continue to sign in</Button>
              </Link>
            </div>
          )}

          {isPending && auth && (
            <Button
              type="button"
              onClick={onAccept}
              disabled={accepting}
              className="mt-5"
            >
              {accepting ? "Joining…" : "Accept and join workspace"}
            </Button>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
