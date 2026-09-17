import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Response } from "express";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { PasswordService } from "../auth/password.service";
import { AuthenticatedRequest } from "../common/request.types";
import { DatabaseService } from "../database/database.service";

type FirstAdminBody = {
  email?: string;
  password?: string;
  orgName?: string;
  demoData?: boolean;
};

interface DemoTCOptions {
  steps?: { step: string; expected: string }[];
  preconditions?: string;
  component?: string;
  severity?: string;
}

@Injectable()
export class SetupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService
  ) {}

  async setupRequired(): Promise<boolean> {
    const result = await this.db.query("SELECT 1 FROM platform_admins WHERE role = 'owner' LIMIT 1");
    return result.rowCount === 0;
  }

  async createFirstAdmin(body: FirstAdminBody, req: AuthenticatedRequest, res: Response) {
    if (!(await this.setupRequired())) {
      throw new ConflictException({ error: "Initial setup is already complete" });
    }
    if (!body.email?.trim() || !body.password?.trim() || !body.orgName?.trim()) {
      throw new BadRequestException({ error: "email, password, and orgName are required" });
    }
    this.password.assertValidPassword(body.password);

    const email = body.email.trim().toLowerCase();
    const orgName = body.orgName.trim();
    const orgSlug = this.slugify(orgName);
    const passwordHash = this.password.hashPassword(body.password);

    try {
      const result = await this.db.transaction(async (client) => {
        const userId = await this.upsertUser(client, email, passwordHash);
        const organizationId = await this.insertOrg(client, orgName, orgSlug);
        await this.insertOrgMember(client, organizationId, userId, "owner");
        await this.insertPlatformOwner(client, userId);

        let projectId = "";
        if (body.demoData) {
          projectId = await this.insertDemoProject(client, organizationId, userId);
          await this.updateUserDefaultProject(client, userId, projectId);
        }
        return { userId, organizationId, projectId };
      });
      await this.auth.signInUser(result.userId, email, req, res);
      await this.audit.log(result.userId, "initial_setup_complete", "organization", result.organizationId, "{}", req.ip, req.get("user-agent"));
      return result;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({ error: "Setup was already completed or the organization slug is taken" });
      }
      throw error;
    }
  }

  private async upsertUser(client: PoolClient, email: string, passwordHash: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO users (email, name, password_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
      RETURNING id
      `,
      [email, email.split("@")[0], passwordHash]
    );
    return result.rows[0].id;
  }

  private async insertOrg(client: PoolClient, name: string, slug: string): Promise<string> {
    const result = await client.query<{ id: string }>("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
      name,
      slug
    ]);
    return result.rows[0].id;
  }

  private async insertOrgMember(client: PoolClient, organizationId: string, userId: string, role: string): Promise<void> {
    await client.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)", [
      organizationId,
      userId,
      role
    ]);
  }

  private async insertPlatformOwner(client: PoolClient, userId: string): Promise<void> {
    await client.query("INSERT INTO platform_admins (user_id, role, granted_by) VALUES ($1, 'owner', $1)", [userId]);
  }

  // eslint-disable-next-line max-lines-per-function
  private async insertDemoProject(client: PoolClient, organizationId: string, userId: string): Promise<string> {
    const project = await client.query<{ id: string }>(
      `
      INSERT INTO projects (organization_id, key, name, description)
      VALUES ($1, 'DEMO', 'HabitNest QA Project', 'Demo project with test cases for the HabitNest habit tracking application.')
      RETURNING id
      `,
      [organizationId]
    );
    const projectId = project.rows[0].id;

    await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [projectId, userId]);

    const suiteNames = [
      "Authentication",
      "Dashboard",
      "Habit Management",
      "Habit Tracking",
      "Reports",
      "Profile & Settings",
      "Reminders",
      "Achievements"
    ];
    const suiteIds: string[] = [];
    for (let i = 0; i < suiteNames.length; i++) {
      const s = await client.query<{ id: string }>(
        "INSERT INTO suites (project_id, parent_id, name, position) VALUES ($1, NULL, $2, $3) RETURNING id",
        [projectId, suiteNames[i], i]
      );
      suiteIds.push(s.rows[0].id);
    }
    const [authId, dashId, habitMgmtId, habitTrackId, reportsId, profileId, remindersId, achievementsId] = suiteIds;

    // ── Authentication (TC-1 to TC-6) ──
    await this.insertDemoTestCase(client, projectId, authId, userId, "DEMO-TC-1", "Register with valid details",
      "Verify a new user can create an account with a valid name, email, password, and matching confirm password.", "P1", {
        preconditions: "The registration screen is accessible and no account exists for the test email.",
        component: "Authentication",
        steps: [
          { step: "Open the registration screen", expected: "The form is displayed with Name, Email, Password, and Confirm Password fields" },
          { step: "Enter a valid name, email, password, and matching confirm password", expected: "All fields accept input without error" },
          { step: "Click the Create Account button", expected: "The user is redirected to the dashboard and the account is created successfully" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, authId, userId, "DEMO-TC-2", "Register with a duplicate email is rejected",
      "Verify the system shows an error and prevents registration when the email address is already registered.", "P2", {
        preconditions: "An account already exists for the email address being used.",
        component: "Authentication",
        steps: [
          { step: "Open the registration screen", expected: "The registration form is displayed" },
          { step: "Enter an email that already exists in the system along with other valid fields", expected: "The form accepts the input" },
          { step: "Click the Create Account button", expected: "An error message is shown indicating the email address is already registered and no new account is created" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, authId, userId, "DEMO-TC-3", "Register with mismatched passwords shows validation error",
      "Verify a validation error is shown and the form is not submitted when password and confirm password do not match.", "P2", {
        preconditions: "The registration screen is accessible.",
        component: "Authentication",
        severity: "Minor",
        steps: [
          { step: "Open the registration screen", expected: "The form is displayed" },
          { step: "Enter a valid name, email, and password, then enter a different value in the Confirm Password field", expected: "Fields accept the input" },
          { step: "Click the Create Account button", expected: "A validation error is shown indicating the passwords do not match and the form is not submitted" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, authId, userId, "DEMO-TC-4", "Login with valid credentials",
      "Verify a registered user can log in successfully and is redirected to the dashboard.", "P1", {
        preconditions: "A registered account exists for the test email.",
        component: "Authentication",
        steps: [
          { step: "Open the login screen", expected: "The login form with Email and Password fields is displayed" },
          { step: "Enter the registered email and the correct password", expected: "Fields accept the input" },
          { step: "Click the Login button", expected: "The user is redirected to the dashboard" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, authId, userId, "DEMO-TC-5", "Login with an invalid password shows an error",
      "Verify a clear error message is shown and the user stays on the login screen when an incorrect password is entered.", "P2", {
        preconditions: "A registered account exists for the test email.",
        component: "Authentication",
        severity: "Minor",
        steps: [
          { step: "Open the login screen", expected: "The login form is displayed" },
          { step: "Enter the registered email and an incorrect password", expected: "Fields accept the input" },
          { step: "Click the Login button", expected: "An error message is displayed indicating invalid credentials and the user remains on the login screen" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, authId, userId, "DEMO-TC-6", "Forgot password request shows confirmation for a registered email",
      "Verify the forgot password screen shows a confirmation message when a valid registered email is submitted.", "P2", {
        preconditions: "The forgot password screen is accessible and the test email is registered.",
        component: "Authentication",
        severity: "Minor",
        steps: [
          { step: "Open the forgot password screen", expected: "The screen is displayed with an Email field and Submit button" },
          { step: "Enter a registered email address and click Submit", expected: "The form is submitted" },
          { step: "Review the screen", expected: "A confirmation message is shown instructing the user to check their email for password reset instructions" }
        ]
      });

    // ── Dashboard (TC-7 to TC-10) ──
    await this.insertDemoTestCase(client, projectId, dashId, userId, "DEMO-TC-7", "Dashboard shows today's active habits after login",
      "Verify the dashboard displays all active habits scheduled for today immediately after login.", "P1", {
        preconditions: "The user has at least two active habits configured.",
        component: "Dashboard",
        steps: [
          { step: "Log in with valid credentials", expected: "The user is redirected to the dashboard" },
          { step: "Review the today's habit list section", expected: "All active habits scheduled for today are listed" },
          { step: "Verify the total, completed, and pending counts match the displayed habit list", expected: "The counts are accurate and consistent with the visible habits" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, dashId, userId, "DEMO-TC-8", "Completed habit count increments when a habit is marked complete",
      "Verify the completed habit count on the dashboard increments by one after marking a habit as complete.", "P1", {
        preconditions: "The dashboard is visible and at least one habit is in a pending state for today.",
        component: "Dashboard",
        steps: [
          { step: "Note the current completed count on the dashboard", expected: "The completed count is visible" },
          { step: "Click the Complete button on a pending habit", expected: "The habit is marked as completed and visually updated" },
          { step: "Check the completed count on the dashboard", expected: "The count has incremented by one" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, dashId, userId, "DEMO-TC-9", "Paused habits do not appear in today's dashboard list",
      "Verify that pausing a habit removes it from the today's habit list on the dashboard.", "P2", {
        preconditions: "The user has at least one active habit visible on the dashboard.",
        component: "Dashboard",
        steps: [
          { step: "Pause an active habit from the habit list screen", expected: "The habit status changes to Paused" },
          { step: "Navigate to the dashboard", expected: "The dashboard today's habit list is displayed" },
          { step: "Confirm the paused habit is not in today's list", expected: "The paused habit does not appear in the today's habits section" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, dashId, userId, "DEMO-TC-10", "Empty state is displayed when no habits exist",
      "Verify the dashboard shows a helpful empty state message and a create habit prompt when the user has no habits.", "P3", {
        preconditions: "The user is logged in with a new account that has no habits.",
        component: "Dashboard",
        severity: "Minor",
        steps: [
          { step: "Log in with an account that has no habits", expected: "The dashboard is displayed" },
          { step: "Review the today's habit list section", expected: "An empty state message is shown indicating no habits exist" },
          { step: "Verify a Create Habit call-to-action is visible", expected: "The user is guided to create their first habit" }
        ]
      });

    // ── Habit Management (TC-11 to TC-18) ──
    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-11", "Create a habit with all required fields",
      "Verify a user can create a new habit by providing all required fields and the habit appears in the list.", "P1", {
        preconditions: "The user is logged in.",
        component: "Habit Management",
        steps: [
          { step: "Click the Create Habit button from the dashboard", expected: "The create habit form is displayed" },
          { step: "Enter a habit name, select a category, frequency, and start date", expected: "All fields accept valid input" },
          { step: "Click the Save button", expected: "The habit is created, a success confirmation is shown, and the habit is visible in the habit list" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-12", "Create a habit with a reminder enabled",
      "Verify a habit can be saved with a reminder time configured and the reminder is reflected in the habit list.", "P2", {
        preconditions: "The user is logged in.",
        component: "Habit Management",
        steps: [
          { step: "Open the create habit screen and fill in all required fields", expected: "The form is displayed and fields accept input" },
          { step: "Toggle the reminder option on and set a specific reminder time", expected: "The reminder time field appears and accepts a time value" },
          { step: "Click Save and navigate to the habit list", expected: "The habit is created with reminder status shown as enabled and the correct reminder time displayed" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-13", "Habit name is required when creating a habit",
      "Verify that leaving the habit name blank prevents form submission and shows a validation error.", "P2", {
        preconditions: "The user is logged in and the create habit screen is open.",
        component: "Habit Management",
        severity: "Minor",
        steps: [
          { step: "Open the create habit screen", expected: "The form is displayed" },
          { step: "Leave the habit name field empty and fill in all other required fields", expected: "Only the habit name field is blank" },
          { step: "Click the Save button", expected: "A validation error is shown indicating the habit name is required and the form is not submitted" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-14", "Edit an existing habit's details",
      "Verify a user can update a habit's name and category from the edit screen and the changes are reflected everywhere.", "P1", {
        preconditions: "At least one active habit exists.",
        component: "Habit Management",
        steps: [
          { step: "Open the habit list and click Edit on an existing habit", expected: "The edit habit form opens with all current details pre-filled" },
          { step: "Update the habit name and select a different category", expected: "The fields are updated with the new values" },
          { step: "Click Save Changes", expected: "The updated details are saved and reflected in both the habit list and the dashboard" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-15", "Cancel editing a habit discards changes",
      "Verify that clicking Cancel on the edit habit screen discards all changes and leaves the habit data unchanged.", "P2", {
        preconditions: "At least one active habit exists.",
        component: "Habit Management",
        severity: "Minor",
        steps: [
          { step: "Open the edit habit screen for an existing habit", expected: "The form is pre-filled with current habit data" },
          { step: "Modify the habit name or other fields", expected: "Fields show the new values" },
          { step: "Click the Cancel button", expected: "The user is returned to the previous screen and the habit data remains unchanged" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-16", "Deleting a habit removes it from the list and dashboard",
      "Verify that deleting a habit removes it from the habit list and it no longer appears on the dashboard.", "P1", {
        preconditions: "At least one active habit exists.",
        component: "Habit Management",
        steps: [
          { step: "Open the habit list and select a habit to delete", expected: "The delete option is visible for the selected habit" },
          { step: "Click Delete and confirm the deletion in the confirmation dialog", expected: "The deletion is confirmed" },
          { step: "Return to the habit list and check the dashboard", expected: "The deleted habit no longer appears in either location" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-17", "Pausing a habit hides it from the dashboard",
      "Verify that pausing a habit removes it from today's habit list on the dashboard.", "P2", {
        preconditions: "At least one active habit is visible on the dashboard.",
        component: "Habit Management",
        steps: [
          { step: "Go to the habit list and click Pause on an active habit", expected: "The habit status changes to Paused" },
          { step: "Navigate to the dashboard", expected: "The dashboard is displayed" },
          { step: "Verify the paused habit does not appear in today's list", expected: "The paused habit is absent from the today's habit section" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitMgmtId, userId, "DEMO-TC-18", "Resuming a paused habit restores it to the dashboard",
      "Verify that resuming a paused habit makes it visible again in today's habit list on the dashboard.", "P2", {
        preconditions: "At least one habit is in a Paused state.",
        component: "Habit Management",
        steps: [
          { step: "Open the habit list and find a paused habit", expected: "The habit shows a Paused status" },
          { step: "Click the Resume button on the paused habit", expected: "The habit status changes back to Active" },
          { step: "Navigate to the dashboard", expected: "The resumed habit appears in today's habit list" }
        ]
      });

    // ── Habit Tracking (TC-19 to TC-23) ──
    await this.insertDemoTestCase(client, projectId, habitTrackId, userId, "DEMO-TC-19", "Marking a habit complete updates the progress percentage",
      "Verify that completing a habit updates the daily completion percentage on the tracking screen.", "P1", {
        preconditions: "The user is logged in and has at least one pending habit for today.",
        component: "Habit Tracking",
        steps: [
          { step: "Navigate to the dashboard and note the current progress percentage", expected: "The progress percentage is visible" },
          { step: "Click the Complete button on a pending habit", expected: "The habit is marked as completed" },
          { step: "Verify the progress percentage updates", expected: "The completion percentage has increased to reflect the newly completed habit" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitTrackId, userId, "DEMO-TC-20", "Undo a completed habit reverts it to pending",
      "Verify that the undo action on a completed habit changes its status back to pending and updates the progress percentage.", "P2", {
        preconditions: "At least one habit has been marked as complete today.",
        component: "Habit Tracking",
        steps: [
          { step: "Go to the daily tracking screen and find a completed habit", expected: "The completed habit is visible with an undo option" },
          { step: "Click the Undo action on the completed habit", expected: "The habit reverts to a pending state" },
          { step: "Verify the progress percentage decreases", expected: "The percentage updates to reflect the undone completion" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitTrackId, userId, "DEMO-TC-21", "Completing a habit increments the streak count",
      "Verify that completing a habit for consecutive days increments the streak count shown in habit details.", "P1", {
        preconditions: "The user has an active habit with at least one previous day completed.",
        component: "Habit Tracking",
        steps: [
          { step: "Open the habit details screen and note the current streak count", expected: "The current streak count is visible" },
          { step: "Mark the habit as complete for today from the dashboard", expected: "The habit is marked as complete" },
          { step: "Return to the habit details screen", expected: "The current streak count has incremented by one" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitTrackId, userId, "DEMO-TC-22", "A habit can only be completed once per day",
      "Verify the system prevents a habit from being marked complete more than once on the same calendar day.", "P1", {
        preconditions: "At least one active habit exists for today.",
        component: "Habit Tracking",
        steps: [
          { step: "Mark a habit as complete from the daily tracking screen", expected: "The habit is marked as completed for today" },
          { step: "Attempt to click the Complete button again on the same habit", expected: "The complete action is disabled or not available" },
          { step: "Verify the system prevents a second completion for the same habit on the same day", expected: "The habit remains in a single completed state with no duplicate entry created" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, habitTrackId, userId, "DEMO-TC-23", "Completion status persists after page refresh",
      "Verify that a habit marked as complete remains in the completed state after the page is refreshed.", "P2", {
        preconditions: "At least one habit has been marked as complete today.",
        component: "Habit Tracking",
        steps: [
          { step: "Mark a habit as complete on the daily tracking screen", expected: "The habit shows a completed state" },
          { step: "Refresh the page", expected: "The page reloads" },
          { step: "Review the habit's status", expected: "The habit is still shown as completed and the progress percentage is preserved" }
        ]
      });

    // ── Reports (TC-24 to TC-29) ──
    await this.insertDemoTestCase(client, projectId, reportsId, userId, "DEMO-TC-24", "Weekly report shows correct completion data",
      "Verify the weekly report accurately reflects the user's habit completions and misses for the current week.", "P1", {
        preconditions: "The user has habit activity recorded for the current week.",
        component: "Reports",
        steps: [
          { step: "Navigate to the weekly report screen", expected: "The report for the current week is displayed" },
          { step: "Review the total completed and missed habit counts", expected: "The counts match the user's actual habit activity for the week" },
          { step: "Verify the day-wise progress breakdown is shown", expected: "Each day of the week displays the correct completion data" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, reportsId, userId, "DEMO-TC-25", "Weekly report only shows data for the logged-in user",
      "Verify the weekly report displays only the current user's habit data and contains no data from other accounts.", "P2", {
        preconditions: "At least two user accounts exist with different habit activity.",
        component: "Reports",
        steps: [
          { step: "Log in as User A and navigate to the weekly report", expected: "The report shows User A's habit data" },
          { step: "Log out and log in as User B", expected: "The session switches to User B" },
          { step: "Navigate to the weekly report for User B", expected: "The report shows different data specific to User B with no data from User A present" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, reportsId, userId, "DEMO-TC-26", "Monthly report displays the best streak",
      "Verify the monthly report shows the highest consecutive day streak achieved during the selected month.", "P1", {
        preconditions: "The user has habit activity recorded for the current or a previous month.",
        component: "Reports",
        steps: [
          { step: "Navigate to the monthly report screen", expected: "The report for the current month is displayed" },
          { step: "Review the best streak field", expected: "The best streak shows the highest consecutive day completion streak for the month" },
          { step: "Verify the overall completion rate is displayed", expected: "A percentage completion rate for the selected month is visible" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, reportsId, userId, "DEMO-TC-27", "Monthly report allows selecting a previous month",
      "Verify the user can use the month selector to navigate to and view report data for a previous month.", "P2", {
        preconditions: "The user has habit activity recorded for at least the previous month.",
        component: "Reports",
        steps: [
          { step: "Navigate to the monthly report screen", expected: "The current month's report is displayed" },
          { step: "Use the month selector to choose the previous month", expected: "The selector updates to the chosen previous month" },
          { step: "Verify the report data updates", expected: "Historical habit data for the prior month is shown correctly" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, reportsId, userId, "DEMO-TC-28", "Report shows empty state when no data exists for the period",
      "Verify the report screen shows a clear empty state message when no habit activity exists for the selected period.", "P3", {
        preconditions: "The user has no habit activity for the period being selected.",
        component: "Reports",
        severity: "Minor",
        steps: [
          { step: "Navigate to the weekly or monthly report screen", expected: "The report screen is displayed" },
          { step: "Select a period for which no habit activity exists", expected: "The report attempts to load data" },
          { step: "Review the report area", expected: "A clear empty state message is shown indicating no data is available for the selected period" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, reportsId, userId, "DEMO-TC-29", "Deleted habits do not appear in reports",
      "Verify that deleting a habit removes it from all report views going forward.", "P2", {
        preconditions: "The user has a habit with past completions recorded this week.",
        component: "Reports",
        steps: [
          { step: "Delete a habit that has recorded activity this week", expected: "The habit is removed from the habit list" },
          { step: "Navigate to the weekly report", expected: "The report is displayed" },
          { step: "Verify the deleted habit does not appear in the report", expected: "The report does not include the deleted habit's data" }
        ]
      });

    // ── Profile & Settings (TC-30 to TC-34) ──
    await this.insertDemoTestCase(client, projectId, profileId, userId, "DEMO-TC-30", "Profile screen shows correct user details",
      "Verify the profile screen displays the correct name, email, and account creation date for the logged-in user.", "P2", {
        preconditions: "The user is logged in.",
        component: "Profile",
        steps: [
          { step: "Navigate to the profile screen", expected: "The profile screen is displayed" },
          { step: "Review the name, email, and account creation date fields", expected: "The details match the information entered during registration" },
          { step: "Verify the habit summary section is visible", expected: "A summary of the user's habit activity is shown on the profile" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, profileId, userId, "DEMO-TC-31", "User can update their display name",
      "Verify a user can change their name from the edit profile screen and the updated name persists.", "P2", {
        preconditions: "The user is logged in.",
        component: "Profile",
        steps: [
          { step: "Navigate to the edit profile screen", expected: "The form is pre-filled with the current name and email" },
          { step: "Update the name field with a new value and click Save", expected: "The change is submitted" },
          { step: "Return to the profile screen and refresh the page", expected: "The updated name is displayed and persists after the refresh" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, profileId, userId, "DEMO-TC-32", "Email is read-only on the edit profile screen",
      "Verify that the email field on the edit profile screen cannot be modified.", "P2", {
        preconditions: "The user is on the edit profile screen.",
        component: "Profile",
        severity: "Minor",
        steps: [
          { step: "Navigate to the edit profile screen", expected: "The form is displayed with name and email fields" },
          { step: "Attempt to click and edit the email field", expected: "The email field appears disabled or read-only" },
          { step: "Verify the email cannot be changed", expected: "The field does not accept input and the original email remains" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, profileId, userId, "DEMO-TC-33", "Change password succeeds with the correct current password",
      "Verify a user can successfully change their password when the correct current password is provided.", "P1", {
        preconditions: "The user is logged in and on the change password screen.",
        component: "Profile",
        steps: [
          { step: "Open the change password screen", expected: "The form with Current Password, New Password, and Confirm New Password fields is displayed" },
          { step: "Enter the correct current password and a valid new password in both new password fields, then click Save", expected: "The form is submitted" },
          { step: "Log out and log back in with the new password", expected: "Login succeeds with the new password; the old password no longer works" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, profileId, userId, "DEMO-TC-34", "Change password fails with an incorrect current password",
      "Verify an error message is shown when the wrong current password is entered on the change password screen.", "P2", {
        preconditions: "The user is logged in and on the change password screen.",
        component: "Profile",
        severity: "Minor",
        steps: [
          { step: "Open the change password screen", expected: "The form is displayed" },
          { step: "Enter an incorrect current password with a valid new password and confirmation, then click Save", expected: "The form is submitted" },
          { step: "Review the screen", expected: "An error message is shown indicating the current password is incorrect and the password is not changed" }
        ]
      });

    // ── Reminders (TC-35 to TC-37) ──
    await this.insertDemoTestCase(client, projectId, remindersId, userId, "DEMO-TC-35", "Enabling a reminder for a habit saves the reminder time",
      "Verify that enabling a reminder and setting a time is saved and shown correctly in reminder settings.", "P2", {
        preconditions: "The user has at least one habit without a reminder configured.",
        component: "Reminders",
        steps: [
          { step: "Open the edit habit screen for a habit with no reminder", expected: "The form shows the reminder toggle in a disabled state" },
          { step: "Toggle the reminder on, set a reminder time, and save", expected: "The habit is saved with the reminder enabled" },
          { step: "Navigate to the reminder settings screen", expected: "The habit is listed with reminder enabled and the correct time is shown" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, remindersId, userId, "DEMO-TC-36", "Reminders are not triggered for already-completed habits",
      "Verify the system does not send a reminder notification for a habit that has already been completed for the day.", "P2", {
        preconditions: "The user has a habit with a reminder enabled and the reminder time is set to a few minutes in the future.",
        component: "Reminders",
        steps: [
          { step: "Mark the reminder-enabled habit as complete before the scheduled reminder time", expected: "The habit shows a completed status for today" },
          { step: "Wait for the scheduled reminder time to pass", expected: "The system processes its scheduled reminders" },
          { step: "Verify no notification is sent for the completed habit", expected: "No reminder notification is received for the already-completed habit" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, remindersId, userId, "DEMO-TC-37", "Reminders are not triggered for paused habits",
      "Verify no reminder notification is sent for a habit that is in a paused state.", "P2", {
        preconditions: "The user has an active habit with a reminder enabled.",
        component: "Reminders",
        steps: [
          { step: "Pause a habit that has a reminder enabled", expected: "The habit status changes to Paused" },
          { step: "Wait for the scheduled reminder time to pass", expected: "The system processes its scheduled reminders" },
          { step: "Verify no reminder notification is sent for the paused habit", expected: "No notification is received for the paused habit at the scheduled time" }
        ]
      });

    // ── Achievements (TC-38 to TC-40) ──
    await this.insertDemoTestCase(client, projectId, achievementsId, userId, "DEMO-TC-38", "Earned badges are visible in the achievements screen",
      "Verify that badges appear in the earned section of the achievements screen once their unlock condition is met.", "P3", {
        preconditions: "The user has completed the conditions required to earn at least one badge (e.g. 7-day streak).",
        component: "Achievements",
        severity: "Minor",
        steps: [
          { step: "Complete the required condition for a badge such as completing a habit for 7 consecutive days", expected: "The condition for earning the badge is satisfied" },
          { step: "Navigate to the achievements screen", expected: "The achievements screen is displayed" },
          { step: "Review the earned badges section", expected: "The badge name, description, and earned date are visible in the earned badges area" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, achievementsId, userId, "DEMO-TC-39", "Locked badges are shown separately with unlock conditions",
      "Verify that unearned badges are displayed in a separate locked section with a description of how to earn them.", "P3", {
        preconditions: "The user is logged in and the achievements screen is accessible.",
        component: "Achievements",
        severity: "Minor",
        steps: [
          { step: "Navigate to the achievements screen", expected: "The achievements screen is displayed" },
          { step: "Review the locked badges section", expected: "A list of badges not yet earned is shown separately from the earned badges" },
          { step: "Inspect a locked badge", expected: "The badge shows its name, description, and the specific condition required to unlock it" }
        ]
      });

    await this.insertDemoTestCase(client, projectId, achievementsId, userId, "DEMO-TC-40", "The same badge cannot be awarded more than once",
      "Verify that a badge already earned is not duplicated in the earned badges section when the condition is met again.", "P2", {
        preconditions: "The user has already earned at least one badge.",
        component: "Achievements",
        steps: [
          { step: "Earn a badge by meeting the required condition for the first time", expected: "The badge appears once in the earned badges section" },
          { step: "Meet the same badge condition again (e.g. achieve another qualifying streak)", expected: "The action is recorded by the system" },
          { step: "Navigate to the achievements screen", expected: "The badge appears only once with no duplicates in the earned badges list" }
        ]
      });

    // ── Knowledge Base ──
    // Hard-delete remediation Phase 8: this used to write into the legacy, flat
    // knowledge_base_items table (v1), which no screen in the product can display — the v2
    // knowledge base (folders -> documents) is the only one the UI reads. insertDemoProject never
    // called seedKnowledgeBaseDefaults either, so the demo project had no root folder at all; both
    // are fixed together here, since a document needs a folder to belong to.
    const rootFolder = await client.query<{ id: string }>(
      `INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root)
       VALUES ($1, $2, NULL, 'Knowledge base', true) RETURNING id`,
      [organizationId, projectId]
    );
    const rootFolderId = rootFolder.rows[0].id;

    await this.insertDemoKnowledgeBaseItem(client, organizationId, projectId, rootFolderId, userId, "HabitNest – Product Overview",
      `# HabitNest – Product Overview

HabitNest is a habit tracking application that helps users build and maintain consistent daily routines.

## Core Value Proposition
Users can create habits, track daily progress, maintain streaks, receive reminders, and view weekly or monthly performance reports.

## Target Users
Individuals who want to improve their daily routine and stay consistent with personal goals.

## Key Capabilities
- Create and manage personal habits with name, category, frequency, and start date
- Mark habits as complete each day and maintain streaks
- Set per-habit reminders with custom notification times
- View weekly and monthly performance reports
- Earn badges and achievements for consistency milestones
- Manage profile and account settings

## Application Status
HabitNest is an MVP-stage product. The recommended first release targets ten core screens: Welcome, Registration, Login, Dashboard, Create Habit, Habit List, Edit Habit, Habit Details, Weekly Report, and Profile.`
    );

    await this.insertDemoKnowledgeBaseItem(client, organizationId, projectId, rootFolderId, userId, "HabitNest – Screen Inventory",
      `# HabitNest – Screen Inventory

A reference list of all screens in the HabitNest application and their purpose.

## Authentication Screens
| Screen | Purpose |
|--------|---------|
| Welcome / Landing | First screen; entry point to login or registration |
| User Registration | New users create an account |
| Login | Existing users access their account |
| Forgot Password | Users request a password reset link |
| Change Password | Users update their password from their profile |

## Core App Screens
| Screen | Purpose |
|--------|---------|
| Dashboard | Main screen after login; shows today's habit progress and counts |
| Create Habit | Form to create a new habit |
| Habit List | Shows all user habits with search and filter options |
| Edit Habit | Update an existing habit's details |
| Habit Details | Full information about a single habit including streak and completion history |
| Daily Habit Tracking | Manage today's completions with complete and undo actions |
| Edit Profile | Update the user's display name |
| Profile | View account details and habit summary |
| Reminder Settings | Manage reminder preferences per habit |
| Achievements | View earned and locked badges |

## Report Screens
| Screen | Purpose |
|--------|---------|
| Weekly Report | Habit performance for the current week with day-wise breakdown |
| Monthly Report | Long-term habit performance with best streak and completion rate |

## State and Utility Screens
| Screen | Purpose |
|--------|---------|
| Empty States | Guidance screens when no data exists (no habits, no results, no reports) |
| Error and Validation | Inform users when something goes wrong with clear actionable messages |`
    );

    await this.insertDemoKnowledgeBaseItem(client, organizationId, projectId, rootFolderId, userId, "Habit Entity – Rules and Validations",
      `# Habit Entity – Business Rules and Validations

## Required Fields
- **Habit Name** – mandatory on both create and edit; must not be blank
- **Frequency** – mandatory; defines how often the habit should be performed
- **Start Date** – mandatory; habits must not appear on the dashboard before this date

## Optional Fields
- **Category** – selectable but not required
- **Reminder** – optional toggle; if enabled, the reminder time field becomes required
- **Difficulty** – defaults to Medium if the user does not select a value

## Habit Status Values
| Status | Behaviour |
|--------|-----------|
| Active | Appears in today's dashboard list and counts toward reports |
| Paused | Hidden from dashboard; reminders not sent; skipped in report missed counts |
| Deleted | Removed from all lists and views; not shown in any report |

## Streak Rules
- Streak increments when a habit is completed on consecutive calendar days
- Missing a day resets the current streak; the longest streak value is preserved
- Undoing a completion on the same day reverts the streak to its prior value

## Daily Completion Rules
- A habit can be completed at most once per calendar day
- Completion status persists across page refreshes
- Undo is only available on the current day and reverts the habit to pending`
    );

    await this.insertDemoKnowledgeBaseItem(client, organizationId, projectId, rootFolderId, userId, "Authentication and Account Rules",
      `# Authentication and Account Rules

## Registration Validation
- All fields (Name, Email, Password, Confirm Password) are mandatory
- Email must be in a valid format
- Password and Confirm Password must match
- Duplicate email registration is not allowed; a clear error must be shown
- Successful registration redirects the user to the dashboard

## Login Validation
- Email and Password are mandatory
- Login is only allowed with valid registered credentials
- Invalid credentials must show a clear error; no technical details exposed
- Already logged-in users should not be shown the login screen
- Successful login redirects the user to the dashboard

## Forgot Password
- Email field is mandatory and must be in a valid format
- If the email is registered, a reset instruction message is shown
- If the email is not found, a generic message is shown (no disclosure of whether the account exists)

## Change Password Rules
- All three fields (Current, New, Confirm New) are mandatory
- The current password must be verified before the change is applied
- New Password and Confirm New Password must match
- New password must comply with the platform's password strength requirements
- After a successful change the user can log in with the new password; the old one is invalidated

## Session Rules
- Sessions expire after a period of inactivity
- Protected screens must redirect unauthenticated users to the login screen
- Logout must end the session and redirect to the login screen`
    );

    await this.insertDemoKnowledgeBaseItem(client, organizationId, projectId, rootFolderId, userId, "Report Behaviour Notes",
      `# Report Behaviour Notes

## Weekly Report
- Displays data for the selected week; defaults to the current week
- Groups progress by day showing a 7-day view
- Metrics shown: total completed habits, total missed habits, completion percentage, day-wise breakdown, and habit-wise breakdown
- Data is scoped strictly to the logged-in user
- Shows an empty state message if no activity exists for the selected week

## Monthly Report
- Displays data for the selected month; defaults to the current month
- User can navigate to previous months using the month selector
- Metrics shown: best streak, overall completion rate, total completed, total missed, and habit-wise monthly summary
- Deleted habits are excluded from all reports
- Shows an empty state message if no activity exists for the selected month

## Data Consistency Rules
- Paused habits during a period should not count as missed days in reports
- Deleted habits must not appear in any report view
- Report data should update in real time when habit completion status changes
- Only the logged-in user's data must be shown; cross-account data must never appear

## Edge Cases to Test
- Switching between months with and without data
- Habits that were active for part of the month then paused
- Streaks that span across week or month boundaries`
    );

    await this.insertDemoKnowledgeBaseItem(client, organizationId, projectId, rootFolderId, userId, "Empty States and Error Scenarios",
      `# Empty States and Error Scenarios

## Empty States
Each empty state must show a clear message and, where applicable, a call-to-action to guide the user.

| Trigger | Expected Empty State |
|---------|---------------------|
| No habits created | Message indicating no habits + Create Habit button |
| No habits for today | Message indicating nothing scheduled + Create Habit button |
| No search results in habit list | Message indicating no matching habits |
| No report data for the selected period | Message indicating no activity data available |
| No achievements earned | Message + hint on how to earn the first badge |
| No reminders enabled | Message + guidance to enable reminders on a habit |

## Error Cases
All errors must be presented with user-friendly language. Raw technical messages must never be shown.

| Scenario | Expected Behaviour |
|----------|--------------------|
| Invalid login credentials | Clear error on the login screen; user stays on the screen |
| Registration with duplicate email | Error indicating the email is already registered |
| Required field missing | Inline validation error; form not submitted |
| Invalid email format | Inline validation error highlighting the email field |
| Password mismatch (registration or change password) | Inline error indicating the passwords do not match |
| Unauthorized access attempt (no session) | Redirect to the login screen |
| Session expired mid-session | Redirect to login with an appropriate expiry message |
| Server or data load failure | Friendly error message; app must not crash; no technical details shown |

## Key Principle
Error messages must be clear, actionable, and written in plain language. The user should always know what went wrong and what to do next.`
    );

    return projectId;
  }

  private async insertDemoTestCase(
    client: PoolClient,
    projectId: string,
    suiteId: string,
    ownerId: string,
    externalId: string,
    title: string,
    description: string,
    priority: string,
    options: DemoTCOptions = {}
  ): Promise<void> {
    const steps = options.steps ?? [
      { step: "Open the application", expected: "The application loads successfully" },
      { step: "Perform the primary action", expected: "The action completes without errors" },
      { step: "Review the resulting screen", expected: "The expected state is visible" }
    ];
    const preconditions = options.preconditions ?? "The HabitNest application is running and the user has a registered account.";
    const component = options.component ?? "General";
    const severity = options.severity ?? "Major";

    await client.query(
      `
      INSERT INTO testcases
        (project_id, suite_id, external_id, title, description, preconditions, steps, test_data,
         priority, severity, type, automation_status, owner_id, component, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'Functional', 'Not Automated', $11, $12, 'Ready')
      `,
      [
        projectId,
        suiteId,
        externalId,
        title,
        description,
        preconditions,
        JSON.stringify(steps),
        "Use the demo account created during onboarding.",
        priority,
        severity,
        ownerId,
        component
      ]
    );
  }

  // Writes into the v2 knowledge base (knowledge_documents), the only one the product UI reads —
  // see the call site's comment. Mirrors createKnowledgeDocument's own shape (status 'draft',
  // document_type 'general'): the search_vector trigger (V45) populates itself on insert, so these
  // notes are keyword-searchable immediately. Semantic/RAG embeddings are not enqueued here (no
  // embedding-queue dependency exists in this service) — a smaller gap than the notes being
  // entirely invisible, and out of this fix's scope.
  private async insertDemoKnowledgeBaseItem(
    client: PoolClient,
    organizationId: string,
    projectId: string,
    folderId: string,
    userId: string,
    title: string,
    content: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, document_type, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'general', 'draft', $6, $6)`,
      [organizationId, projectId, folderId, title, content, userId]
    );
  }

  private async updateUserDefaultProject(client: PoolClient, userId: string, projectId: string): Promise<void> {
    await client.query("UPDATE users SET default_project_id = $1, updated_at = now() WHERE id = $2", [projectId, userId]);
  }

  private slugify(name: string): string {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(?:^-)|(?:-$)/g, "");
    return (slug || "org").slice(0, 64);
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
  }
}
