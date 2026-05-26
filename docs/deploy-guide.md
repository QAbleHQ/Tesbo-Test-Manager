# Tesbo DigitalOcean Deploy Guide

This guide covers the first public release: the core test case management platform.

## Architecture

| Component | Target | Port |
|-----------|--------|------|
| Frontend | Droplet with Nginx + Docker Compose | 443 -> Nginx -> 127.0.0.1:3000 |
| Backend | Droplet with Nginx + Docker Compose | 443 -> Nginx -> 127.0.0.1:7000 |
| PostgreSQL | Managed database or self-hosted PostgreSQL | 5432 |

All images are stored in DigitalOcean Container Registry (DOCR).

Each droplet runs Nginx as a reverse proxy with Let's Encrypt SSL certificates. Docker containers bind to localhost only. The deploy workflow handles Nginx and Certbot setup through `deploy/nginx/setup-ssl.sh`.

## Workflow

Manual trigger:

```text
.github/workflows/deploy.yml
```

## Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `DO_API_TOKEN` | DigitalOcean API token |
| `DOCR_REGISTRY` | e.g. `registry.digitalocean.com/your-registry` |
| `DOCR_REPO_FRONTEND` | Frontend image repo name |
| `DOCR_REPO_BACKEND` | Backend image repo name |
| `DROPLET_FRONTEND_IP` | Frontend droplet IP |
| `DROPLET_BACKEND_IP` | Backend droplet IP |
| `SSH_PRIVATE_KEY` | SSH key for droplet access |
| `NEXT_PUBLIC_API_URL` | Public backend URL, e.g. `https://api.example.com` |
| `FRONTEND_DOMAIN` | Frontend domain |
| `BACKEND_DOMAIN` | Backend domain |
| `CERTBOT_EMAIL` | Email for Let's Encrypt certificate notifications |

Backend runtime secrets:

- `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`
- `CORS_ALLOWED_ORIGINS`
- `FRONTEND_URL`, `SESSION_DAYS`
- `POSTMARK_API_TOKEN`, `POSTMARK_FROM_EMAIL`
- `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`
- `TESBO_ARTIFACT_STORAGE_PROVIDER`, `TESBO_SPACES_*`

## Deploy Flow

1. Add or update all GitHub secrets.
2. Trigger **Deploy Tesbo to DigitalOcean** from GitHub Actions.
3. The workflow builds and pushes frontend and backend images with `sha` and `latest` tags.
4. The workflow deploys each image to its droplet through SSH and Docker Compose.

## Droplet Prep

Run once per droplet:

```bash
curl -fsSL https://get.docker.com | sh
```

Open firewall ports: `22`, `80`, `443`.

## DNS Setup

Point each domain to the corresponding droplet IP as a plain A record.

| Record | Type | Value | Proxy |
|--------|------|-------|-------|
| `app.example.com` | A | `<FRONTEND_IP>` | DNS only |
| `api.example.com` | A | `<BACKEND_IP>` | DNS only |

## Verification

- Frontend: `https://app.example.com/`
- Backend health: `https://api.example.com/health`
