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
    if (body.password.length < 8) {
      throw new BadRequestException({ error: "Password must be at least 8 characters" });
    }

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

  private async insertDemoProject(client: PoolClient, organizationId: string, userId: string): Promise<string> {
    const project = await client.query<{ id: string }>(
      `
      INSERT INTO projects (organization_id, key, name, description)
      VALUES ($1, 'DEMO', 'Demo QA Project', 'Sample project with starter test cases for exploring Tesbo.')
      RETURNING id
      `,
      [organizationId]
    );
    const projectId = project.rows[0].id;
    const suite = await client.query<{ id: string }>(
      "INSERT INTO suites (project_id, parent_id, name, position) VALUES ($1, NULL, 'Web App Smoke Tests', 0) RETURNING id",
      [projectId]
    );
    const suiteId = suite.rows[0].id;
    await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [projectId, userId]);
    await this.insertDemoTestCase(
      client,
      projectId,
      suiteId,
      userId,
      "DEMO-TC-1",
      "Sign in with valid credentials",
      "Verify a user can sign in and land on the project listing screen.",
      "P1"
    );
    await this.insertDemoTestCase(
      client,
      projectId,
      suiteId,
      userId,
      "DEMO-TC-2",
      "Create a new project",
      "Verify an owner can create a Tesbo project with name and key.",
      "P2"
    );
    await this.insertDemoTestCase(
      client,
      projectId,
      suiteId,
      userId,
      "DEMO-TC-3",
      "Invite a workspace member",
      "Verify an owner can invite a teammate from workspace settings.",
      "P2"
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
    priority: string
  ): Promise<void> {
    const steps = [
      { step: "Open the application", expected: "The application loads successfully" },
      { step: "Perform the primary action", expected: "The action completes without errors" },
      { step: "Review the resulting screen", expected: "The expected state is visible" }
    ];
    await client.query(
      `
      INSERT INTO testcases
        (project_id, suite_id, external_id, title, description, preconditions, steps, test_data,
         priority, severity, type, automation_status, owner_id, component, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'Major', 'Functional', 'Not Automated', $10, 'Onboarding', 'Ready')
      `,
      [
        projectId,
        suiteId,
        externalId,
        title,
        description,
        "Fresh Tesbo deployment is available.",
        JSON.stringify(steps),
        "Use the initial admin account created during setup.",
        priority,
        ownerId
      ]
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
      .replace(/^-|-$/g, "");
    return (slug || "org").slice(0, 64);
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
  }
}
