## BetterCases DigitalOcean CI/CD Guide

### Overview
- Images are built from `frontend/Dockerfile` and `backend/Dockerfile`, pushed to DOCR, then deployed via Docker Compose on each droplet.
- Backend and frontend are deployed on separate droplets using files in `deploy/backend/` and `deploy/frontend/`.
- PostgreSQL is external (managed DB or self-hosted) and configured through `DATABASE_*` env vars.
- Artifact storage supports `local` or DigitalOcean Spaces (`TESBO_*` keys).

### Required GitHub secrets
- `DO_API_TOKEN`
- `DOCR_REGISTRY` (example: `registry.digitalocean.com/your-registry`)
- `DOCR_REPO_FRONTEND`, `DOCR_REPO_BACKEND`
- `DROPLET_FRONTEND_IP`, `DROPLET_BACKEND_IP`
- `SSH_PRIVATE_KEY`
- `NEXT_PUBLIC_API_URL` (example: `https://api.yourdomain.com`)

Backend runtime secrets:
- `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`
- `CORS_ALLOWED_ORIGINS`, `FRONTEND_URL`
- `SESSION_DAYS`, `STATIC_OTP`
- `POSTMARK_API_TOKEN`, `POSTMARK_FROM_EMAIL`
- `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`
- `TESBO_ARTIFACT_STORAGE_PROVIDER`
- `TESBO_SPACES_ENDPOINT`, `TESBO_SPACES_REGION`, `TESBO_SPACES_BUCKET`
- `TESBO_SPACES_ACCESS_KEY`, `TESBO_SPACES_SECRET_KEY`
- `TESBO_SIGNED_URL_TTL_SECONDS`

### Droplet prep (run once)
1. Install Docker and Compose plugin:
   - `curl -fsSL https://get.docker.com | sh`
2. Ensure the deploy SSH key is present for the target user (`root` in the current workflow).
3. Open ports `22`, `80`, and `443` in firewall rules.

### Deploy flow
1. Add/update all required GitHub secrets.
2. Trigger `Deploy BetterCases to DigitalOcean` from GitHub Actions (`workflow_dispatch`).
3. Workflow builds and pushes `frontend` and `backend` images tagged with commit SHA and `latest`.
4. Workflow copies compose files to:
   - Frontend: `/opt/bettercases/frontend`
   - Backend: `/opt/bettercases/backend`
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
