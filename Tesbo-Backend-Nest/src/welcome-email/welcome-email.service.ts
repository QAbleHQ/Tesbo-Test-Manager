import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { EmailService } from "../auth/email.service";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { WELCOME_EMAIL_JOB, WELCOME_EMAIL_QUEUE, welcomeEmailDelayMs, welcomeEmailJobId } from "./welcome-email.constants";

export interface WelcomeEmailJobData {
  userId: string;
}

/**
 * Schedules and sends the post-registration welcome email.
 *
 * The job carries only the user id. The recipient (the user's own email) and the CC (WELCOME_EMAIL_CC)
 * are read when the job fires, so no address sits in Redis and a CC change needs no re-enqueue.
 */
@Injectable()
export class WelcomeEmailService {
  private readonly logger = new Logger(WelcomeEmailService.name);

  constructor(
    @InjectQueue(WELCOME_EMAIL_QUEUE) private readonly queue: Queue<WelcomeEmailJobData>,
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly email: EmailService
  ) {}

  /**
   * Enqueues the welcome email for a just-created user. Call only after the user row is committed.
   *
   * Never throws: this runs after the account exists and the caller is about to be signed in, and a
   * Redis hiccup must not turn a successful registration into a 500. A lost welcome email is logged.
   */
  async schedule(userId: string): Promise<void> {
    try {
      const result = await this.db.query<{ created_at: Date }>("SELECT created_at FROM users WHERE id = $1", [userId]);
      const createdAt = result.rows[0]?.created_at;
      if (!createdAt) {
        this.logger.warn(`Welcome email not scheduled: user ${userId} not found`);
        return;
      }
      await this.queue.add(
        WELCOME_EMAIL_JOB,
        { userId },
        {
          jobId: welcomeEmailJobId(userId),
          delay: welcomeEmailDelayMs(new Date(createdAt)),
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 1000 }
        }
      );
    } catch (error) {
      this.logger.error(`Failed to schedule welcome email for user ${userId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** The job body, sent to the user's own address. Throws on a send failure so BullMQ retries. */
  async send(userId: string): Promise<void> {
    const result = await this.db.query<{ email: string; first_name: string | null; name: string | null }>(
      "SELECT email, first_name, name FROM users WHERE id = $1",
      [userId]
    );
    const user = result.rows[0];
    if (!user) {
      // Deleted in the three hours since registering — nobody left to welcome.
      this.logger.log(`Welcome email skipped: user ${userId} no longer exists`);
      return;
    }
    // The legacy single-shot invite registration stores only a combined `name`.
    const firstName = user.first_name?.trim() || user.name?.trim().split(/\s+/)[0] || "there";
    await this.email.sendWelcome(user.email, this.config.welcomeEmailCc || undefined, firstName);
  }
}
