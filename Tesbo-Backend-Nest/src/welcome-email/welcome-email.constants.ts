export const WELCOME_EMAIL_QUEUE = "welcome-email";
export const WELCOME_EMAIL_JOB = "welcome-email-send";

// 120 seconds after registration (the ticket originally said 3 hours). Measured from
// users.created_at, not from when the job was enqueued, so the email lands at the same point in the
// user's timeline however the enqueue was delayed (see welcomeEmailDelayMs).
export const WELCOME_EMAIL_DELAY_MS = 120 * 1000;

/** One job per user, ever: BullMQ ignores an add() whose jobId already exists. */
export function welcomeEmailJobId(userId: string): string {
  return `welcome-${userId}`;
}

/** Milliseconds from `now` until `createdAt + WELCOME_EMAIL_DELAY_MS`, never negative. */
export function welcomeEmailDelayMs(createdAt: Date, now: number = Date.now()): number {
  return Math.max(0, createdAt.getTime() + WELCOME_EMAIL_DELAY_MS - now);
}
