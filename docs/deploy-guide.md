## TesboX DigitalOcean CI/CD Guide

### Overview
- Images are built from `frontend/Dockerfile`, `backend/Dockerfile`, and `automation-agent/Dockerfile`, pushed to DOCR, then deployed via Docker Compose on each droplet.
- Backend, frontend, and automation services are deployed on separate droplets using files in `deploy/backend/`, `deploy/frontend/`, and `deploy/automation/`.
- PostgreSQL is external (managed DB or self-hosted) and configured through `DATABASE_*` env vars.
- Artifact storage supports `local` or DigitalOcean Spaces (`TESBO_*` keys).

### Required GitHub secrets
- `DO_API_TOKEN`
- `DOCR_REGISTRY` (example: `registry.digitalocean.com/your-registry`)
- `DOCR_REPO_FRONTEND`, `DOCR_REPO_BACKEND`, `DOCR_REPO_AUTOMATION`
- `DROPLET_FRONTEND_IP`, `DROPLET_BACKEND_IP`, `DROPLET_AUTOMATION_IP`
- `SSH_PRIVATE_KEY`
- `NEXT_PUBLIC_API_URL` (example: `https://api.yourdomain.com`)

Backend runtime secrets:
- `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`
- `CORS_ALLOWED_ORIGINS`, `FRONTEND_URL`
- `SESSION_DAYS`
- `POSTMARK_API_TOKEN`, `POSTMARK_FROM_EMAIL`
- `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`
- `TESBO_ARTIFACT_STORAGE_PROVIDER`
- `TESBO_SPACES_ENDPOINT`, `TESBO_SPACES_REGION`, `TESBO_SPACES_BUCKET`
- `TESBO_SPACES_ACCESS_KEY`, `TESBO_SPACES_SECRET_KEY`
- `TESBO_SIGNED_URL_TTL_SECONDS`
- `AUTOMATION_AGENT_BASE_URL` (automation session API)
- `AUTOMATION_QUEUE_API_BASE_URL` (queue enqueue/cancel/stats API; can be separate service)
- `AUTOMATION_AGENT_SHARED_TOKEN` (must match automation `AGENT_SHARED_TOKEN`)
- `AUTOMATION_QUEUE_SHARED_TOKEN`
- `AUTOMATION_QUEUE_MAX_ACTIVE_RUNS_PER_PROJECT`
- `AUTOMATION_QUEUE_MAX_QUEUED_JOBS_PER_PROJECT`
- `AUTOMATION_QUEUE_AUTOSCALE_MIN_WORKERS`
- `AUTOMATION_QUEUE_AUTOSCALE_MAX_WORKERS`
- `AUTOMATION_QUEUE_AUTOSCALE_TARGET_JOBS_PER_WORKER`
- `AUTOMATION_QUEUE_AUTOSCALE_WARM_WORKERS`

Automation runtime secrets:
- `REDIS_URL`
- `BACKEND_BASE_URL`
- `AGENT_SHARED_TOKEN`
- `AUTOMATION_QUEUE_SHARED_TOKEN`
- `AUTOMATION_QUEUE_PREFIX`
- `AUTOMATION_QUEUE_NAME`
- `AUTOMATION_QUEUE_MAX_RETRIES`

### Droplet prep (run once)
1. Install Docker and Compose plugin:
   - `curl -fsSL https://get.docker.com | sh`
2. Ensure the deploy SSH key is present for the target user (`root` in the current workflow).
3. Open ports `22`, `80`, and `443` in firewall rules.

### Deploy flow
1. Add/update all required GitHub secrets.
2. Trigger `Deploy TesboX to DigitalOcean` from GitHub Actions (`workflow_dispatch`).
3. Workflow builds and pushes `frontend`, `backend`, and `automation-agent` images tagged with commit SHA and `latest`.
4. Workflow copies compose files to:
   - Frontend: `/opt/bettercases/frontend`
   - Backend: `/opt/bettercases/backend`
   - Automation: `/opt/bettercases/automation`
5. Workflow writes `.env` and `app.env`, then runs:
   - `docker compose pull`
   - `docker compose up -d --remove-orphans`

### Manual verification
- Frontend: `http://<frontend-ip>/`
- Backend health: `http://<backend-ip>/health`
- Backend API example: `http://<backend-ip>/api/auth/me`

### Manual redeploy by image tag
On each droplet set `IMAGE_TAG=<tag>` in `/opt/bettercases/<service>/.env`, then run:
- `docker compose pull`
- `docker compose up -d --remove-orphans`

### Agent cache note (DigitalOcean)
- DB persistence is enabled for automation agent action trace/events (handled by backend automation session events).
- If you rotate droplets without persistent volumes, DB action trace remains available.

### Queue execution split services (recommended)

- Deploy `automation-agent` in two roles:
  - `AUTOMATION_SERVICE_ROLE=api` for queue API + session API
  - `AUTOMATION_SERVICE_ROLE=worker` for queue processing only
- Point backend to:
  - `AUTOMATION_AGENT_BASE_URL=http://<automation-api-host>:7400`
  - `AUTOMATION_QUEUE_API_BASE_URL=http://<automation-api-host>:7400`
- Scale worker replicas independently (KEDA/queue depth preferred).

### Queue admission and autoscaling

- Backend now enforces per-project execution pressure limits before enqueue:
  - max active runs per project
  - max queued jobs per project
- Backend exposes autoscaling recommendation:
  - `GET /api/internal/automation/autoscaling-recommendation`
  - recommendation uses queued + running job pressure and min/max worker bounds.
