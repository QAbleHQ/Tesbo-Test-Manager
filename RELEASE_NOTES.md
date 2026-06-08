# Tesbo Test Manager Release Notes

## First Public Release

Tesbo Test Manager is now available as an open source test management platform for teams that need one place to manage test cases, organize suites, plan test runs, execute testing, track bugs, connect Jira, and use AI-assisted testcase generation.

This first release focuses on the core workflows needed to start managing QA work end to end.

## What Is Included

### Test Case Repository

- Create, edit, view, and delete test cases.
- Organize test cases into suites.
- Track priority, type, status, automation metadata, tags, owners, components, Jira links, and execution readiness.
- Filter and search test cases across repository views.
- Import/export support for test case data and templates.

### Test Suites

- Create suite structures for organizing repository coverage.
- Move or detach test cases when suites are removed.
- Use suites as filters in repository and report views.

### Test Plans

- Create test plans for planned coverage.
- Add test cases or suites into plan scope.
- Create test runs from plans.
- Track planned execution scope separately from repository content.

### Test Runs And Execution

- Create manual test runs.
- Add approved test cases into a run.
- Start execution and update testcase execution status.
- Supported execution statuses include Untested, Passed, Failed, Skipped, Blocked, and Retest.
- View testcase details while executing, including description, preconditions, test data, and steps.
- Capture actual result notes, defect keys, and defect URLs.
- Mark runs as In Progress, Completed, or reopen them.

### Bug Tracking

- Create bugs directly from failed executions.
- Link bugs to test runs, executions, and test cases.
- Track bug status, description, reporter, external URL, and related testcase/run context.

### Reports

- Execution Report with grouped execution status data.
- Filter execution reports by test run, person, plan, suite, priority, and tags.
- Requirement Traceability Matrix linking test cases, runs, execution results, and bugs.
- Repository Summary with coverage by suite, status, priority, and recent activity.

### Public Sharing

- Generate public share links for test runs.
- Shared links allow external stakeholders to view run results without logging in.
- Sharing can be enabled or disabled per test run.

### Jira Integration

- Configure Jira OAuth settings at the project level.
- Connect Jira and sync Jira tickets into the knowledge base area.
- View synced Jira tickets inside the project.
- Link generated test cases to Jira issue keys.
- Filter test cases by Jira issue key.
- Assign Jira tickets to Zyra for testcase generation or regeneration.

### Knowledge Base

- Add project notes and knowledge items.
- Use knowledge base content as context for AI-assisted testcase generation.
- Connect Jira ticket context into project knowledge workflows.

### Zyra AI Testcase Generation

- Allocate an AI provider key to activate Zyra.
- Create Zyra tasks from story details, project context, selected Jira tickets, and selected knowledge items.
- Zyra tasks move through Todo, In Progress, In Review, and Done.
- Generate testcase drafts for review before saving.
- Regenerate testcase drafts using reviewer feedback.
- Save generated test cases into suites.
- Link generated and regenerated cases back to Jira tickets with identifying tags.

### Admin And Setup

- First-admin setup flow.
- Platform admin management.
- System health dashboard for deployment checks.
- Deployment branding panel where admins can upload a custom logo and product name for their installation.

### Authentication And Access

- Password login and OTP support.
- Workspace and project membership.
- Project-level access management.
- Platform admin role support.

### Deployment

- Docker Compose based local deployment.
- NestJS backend, Next.js frontend, PostgreSQL, and supporting deployment examples.
- Environment examples for backend, frontend, Jira, email, storage, and database configuration.

## Notes For This Release

- This is the first public release, so the focus is on core test management workflows and deployment readiness.
- Some technical identifiers, routes, database names, and environment variables still use existing `tesbo` naming for compatibility.
- Teams should run all backend migrations before using the application in a new environment.
- Admins can customize deployment branding from the Admin dashboard after setup.

## Recommended First Steps

1. Deploy the backend, frontend, and database.
2. Run backend migrations.
3. Create the first admin account.
4. Create a project and add team members.
5. Add suites and test cases.
6. Create a test run and start execution.
7. Configure Jira and AI provider keys if your team wants Jira sync and Zyra testcase generation.

