"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
import {
  acceptInvitation,
  authMe,
  declineInvitation,
  getInvitationByToken,
  type InviteDetails,
} from "@/lib/api";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { BrandLogo } from "@/components/BrandLogo";
import { formatDate } from "@/lib/date";

function roleLabel(role: string): string {
  const n = (role ?? "").trim().toLowerCase();
  if (n === "manager" || n === "admin") return "Manager";
  if (n === "owner") return "Owner";
  return "QA Engineer";
}

type PageState = "loading" | "valid" | "expired" | "cancelled" | "declined" | "accepted" | "invalid";

export default function InviteAcceptancePage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loggedInUserId, setLoggedInUserId] = useState<string | null>(null);
  const [loggedInEmail, setLoggedInEmail] = useState<string | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  // Declining is one-way (the sender has to invite again), so it takes a second click.
  const [confirmingDecline, setConfirmingDecline] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [inv, me] = await Promise.all([
          getInvitationByToken(token),
          authMe().catch(() => null),
        ]);
        if (!active) return;
        setInvite(inv);
        if (me) {
          setLoggedInUserId(me.userId);
          setLoggedInEmail(me.email ?? null);
        }
        if (inv.status === "expired") setState("expired");
        else if (inv.status === "cancelled") setState("cancelled");
        else if (inv.status === "declined") setState("declined");
        else if (inv.status === "accepted") setState("accepted");
        else setState("valid");
      } catch {
        if (active) setState("invalid");
      }
    }
    load();
    return () => { active = false; };
  }, [token]);

  async function handleAccept() {
    setErrorMsg("");
    setAccepting(true);
    try {
      await acceptInvitation(token);
      router.push("/projects");
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to accept invitation";
      setErrorMsg(msg);
    } finally {
      setAccepting(false);
    }
  }

  async function handleDecline() {
    setErrorMsg("");
    setDeclining(true);
    try {
      await declineInvitation(token);
      setConfirmingDecline(false);
      setState("declined");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to decline invitation");
    } finally {
      setDeclining(false);
    }
  }

  // "Not now": leaves the invitation exactly as it is (still pending, still acceptable from the
  // link or the bell) and just takes the person somewhere useful.
  function handleClose() {
    router.push(loggedInUserId ? "/projects" : "/login");
  }

  const invitePath = `/invite/${token}`;
  const loginUrl = `/login?redirect=${encodeURIComponent(invitePath)}&inviteEmail=${encodeURIComponent(invite?.email ?? "")}`;
  const registerUrl = `/invite/${token}/register`;

  // Email mismatch: logged in as a different email
  const emailMismatch =
    loggedInEmail && invite?.email && loggedInEmail.toLowerCase() !== invite.email.toLowerCase();

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[var(--ink-400)]">Loading invitation…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--ink-50)] px-4 py-12">
      <div className="mb-8">
        <BrandLogo className="h-10 w-auto" />
      </div>

      <Card className="relative w-full max-w-md p-8">
        {state === "valid" && (
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            title="Decide later"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--ink-400)] transition-colors hover:bg-[var(--ink-100)] hover:text-[var(--foreground)]"
          >
            <IconX size={18} stroke={1.75} />
          </button>
        )}

        {/* ── Invalid ── */}
        {state === "invalid" && (
          <>
            <CardHeader>
              <CardTitle>Invalid invitation</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="text-sm text-[var(--ink-400)]">
                This invite link is invalid or has already been used. Contact the person who invited you.
              </p>
            </CardBody>
          </>
        )}

        {/* ── Expired ── */}
        {state === "expired" && (
          <>
            <CardHeader>
              <CardTitle>Invitation expired</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="text-sm text-[var(--ink-400)]">
                This invitation has expired. Ask the sender to resend it from the Team management page.
              </p>
            </CardBody>
          </>
        )}

        {/* ── Cancelled ── */}
        {state === "cancelled" && (
          <>
            <CardHeader>
              <CardTitle>Invitation cancelled</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="text-sm text-[var(--ink-400)]">
                This invitation has been cancelled. Contact your team owner if you believe this is a mistake.
              </p>
            </CardBody>
          </>
        )}

        {/* ── Declined ── */}
        {state === "declined" && (
          <>
            <CardHeader>
              <CardTitle>Invitation declined</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <p className="text-sm text-[var(--ink-400)]">
                This invitation was declined. If that was a mistake, ask the sender to invite you again.
              </p>
              {loggedInUserId && (
                <Link href="/projects">
                  <Button variant="secondary" className="w-full">Go to my workspace</Button>
                </Link>
              )}
            </CardBody>
          </>
        )}

        {/* ── Already accepted ── */}
        {state === "accepted" && (
          <>
            <CardHeader>
              <CardTitle>Invitation already accepted</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <p className="text-sm text-[var(--ink-400)]">
                This invitation has already been accepted. Sign in to access the workspace.
              </p>
              <Link href="/login">
                <Button className="w-full">Sign in</Button>
              </Link>
            </CardBody>
          </>
        )}

        {/* ── Valid ── */}
        {state === "valid" && invite && (
          <>
            <CardHeader>
              <CardTitle>You&apos;re invited</CardTitle>
            </CardHeader>
            <CardBody className="space-y-5">
              <div className="rounded-[var(--radius-control)] bg-[var(--ink-100)] px-4 py-3 text-sm">
                <p className="text-[var(--ink-400)]">
                  You have been invited to join{" "}
                  <strong className="text-[var(--foreground)]">
                    {invite.organizationName ?? "this workspace"}
                  </strong>{" "}
                  as{" "}
                  <strong className="text-[var(--foreground)]">{roleLabel(invite.role)}</strong>.
                </p>
                {invite.projects.length > 0 && (
                  <p className="mt-1 text-[var(--ink-400)]">
                    Project access:{" "}
                    <strong className="text-[var(--foreground)]">
                      {invite.projects.map((p) => p.name).join(", ")}
                    </strong>
                  </p>
                )}
                <p className="mt-1 text-xs text-[var(--ink-400)]">
                  Invite sent to {invite.email} · expires{" "}
                  {formatDate(invite.expiresAt)}
                </p>
              </div>

              {errorMsg && (
                <p className="text-sm text-[var(--error-foreground)]">{errorMsg}</p>
              )}

              {/* ── Not logged in ── */}
              {!loggedInUserId && (
                <div className="space-y-3">
                  {invite.hasAccount ? (
                    <>
                      <p className="text-sm text-[var(--ink-400)]">
                        Sign in with <strong>{invite.email}</strong> to accept this invitation.
                      </p>
                      <Link href={loginUrl}>
                        <Button className="w-full">Sign in to accept</Button>
                      </Link>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-[var(--ink-400)]">
                        Create your account to join the workspace.
                      </p>
                      <Link href={registerUrl}>
                        <Button className="w-full">Create account</Button>
                      </Link>
                      <p className="text-center text-xs text-[var(--ink-400)]">
                        Already have an account?{" "}
                        <Link href={loginUrl} className="text-[var(--denim)] hover:underline">
                          Sign in
                        </Link>
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* ── Logged in, email mismatch ── */}
              {loggedInUserId && emailMismatch && (
                <div className="space-y-3">
                  <p className="text-sm text-[var(--error-foreground)]">
                    You are signed in as a different email. This invitation is for{" "}
                    <strong>{invite.email}</strong>. Sign out and sign in with the correct account.
                  </p>
                  <Link href={loginUrl}>
                    <Button variant="secondary" className="w-full">Sign in with {invite.email}</Button>
                  </Link>
                </div>
              )}

              {/* ── Logged in, correct email ── */}
              {loggedInUserId && !emailMismatch && (
                <div className="space-y-3">
                  <Button
                    className="w-full"
                    onClick={handleAccept}
                    disabled={accepting || declining}
                  >
                    {accepting ? "Joining…" : "Accept and join workspace"}
                  </Button>
                  {confirmingDecline ? (
                    <div className="space-y-2 rounded-[var(--radius-control)] border border-[var(--border)] px-4 py-3">
                      <p className="text-sm text-[var(--foreground)]">
                        Decline this invitation? The sender will need to invite you again.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          className="flex-1"
                          onClick={() => setConfirmingDecline(false)}
                          disabled={declining}
                        >
                          Keep it
                        </Button>
                        <Button className="flex-1" onClick={handleDecline} disabled={declining}>
                          {declining ? "Declining…" : "Yes, decline"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => setConfirmingDecline(true)}
                      disabled={accepting}
                    >
                      Decline
                    </Button>
                  )}
                </div>
              )}
            </CardBody>
          </>
        )}
      </Card>
    </div>
  );
}
