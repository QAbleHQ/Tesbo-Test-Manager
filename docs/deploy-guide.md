## TesboX & TesboX-Runner — DigitalOcean Deploy Guide

---

### Architecture Overview

| Product | Component | Target | Port |
|---------|-----------|--------|------|
| **TesboX** | Frontend | Droplet (Nginx + Docker Compose) | 443 → Nginx → 127.0.0.1:3000 |
| **TesboX** | Backend | Droplet (Nginx + Docker Compose) | 443 → Nginx → 127.0.0.1:7000 |
| **TesboX** | Automation Agent | Droplet (Nginx + Docker Compose) | 443 → Nginx → 127.0.0.1:7400 |
| **TesboX-Runner** | Execution API | Droplet (Docker Compose) | 80 → 7420 |
| **TesboX-Runner** | Execution Workers | DOKS Kubernetes (KEDA autoscale) | 7411 |

All images are stored in DigitalOcean Container Registry (DOCR).

Each TesboX droplet runs **Nginx** as a reverse proxy with **Let's Encrypt** SSL certificates
(auto-provisioned and auto-renewed). Docker containers bind to `127.0.0.1` only — not
publicly exposed. The deploy workflow handles Nginx + Certbot setup automatically via
`deploy/nginx/setup-ssl.sh`.

---

### 1. TesboX (Main Platform)

**Workflow:** `.github/workflows/deploy.yml` — manual trigger (`workflow_dispatch`)

#### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `DO_API_TOKEN` | DigitalOcean API token |
| `DOCR_REGISTRY` | e.g. `registry.digitalocean.com/your-registry` |
| `DOCR_REPO_FRONTEND` | Frontend image repo name |
| `DOCR_REPO_BACKEND` | Backend image repo name |
| `DOCR_REPO_AUTOMATION_AGENT` | Automation agent image repo name |
| `DROPLET_FRONTEND_IP` | Frontend droplet IP |
| `DROPLET_BACKEND_IP` | Backend droplet IP |
| `DROPLET_AUTOMATION_AGENT_IP` | Automation agent droplet IP |
| `SSH_PRIVATE_KEY` | SSH key for droplet access |
| `NEXT_PUBLIC_API_URL` | e.g. `https://backdoor.tesbo.io` |
| `AGENT_SHARED_TOKEN` | Shared token between backend ↔ automation agent |
| `FRONTEND_DOMAIN` | Domain for the frontend droplet, e.g. `frontdoor.tesbo.io` |
| `BACKEND_DOMAIN` | Domain for the backend droplet, e.g. `backdoor.tesbo.io` |
| `AUTOMATION_AGENT_DOMAIN` | Domain for the automation agent droplet, e.g. `automate.tesbo.io` |
| `CERTBOT_EMAIL` | Email for Let's Encrypt certificate notifications |

Backend runtime secrets:
- `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`
- `CORS_ALLOWED_ORIGINS` — comma-separated browser origins allowed to call the API (must include your SPA origin, e.g. `https://frontdoor.tesbo.io`). Optional extras: `https://automate.tesbo.io`, `https://exe.tesbo.io` only if a **browser** UI on those hosts calls backdoor; automation agents and execution workers use server-to-server HTTP and do not rely on CORS.
- `FRONTEND_URL`, `SESSION_DAYS`
- `POSTMARK_API_TOKEN`, `POSTMARK_FROM_EMAIL`
- `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`
- `TESBO_ARTIFACT_STORAGE_PROVIDER`, `TESBO_SPACES_*`
- `AUTOMATION_AGENT_BASE_URL`, `AUTOMATION_QUEUE_MAX_RETRIES`
- `EXECUTION_SERVICE_BASE_URL`, `EXECUTION_SERVICE_API_KEY`
- `EXECUTION_SERVICE_WEBHOOK_URL`, `EXECUTION_SERVICE_WEBHOOK_SECRET`

#### Deploy Flow

1. Add/update all GitHub secrets.
2. Trigger **Deploy TesboX to DigitalOcean** from GitHub Actions.
3. Workflow builds and pushes Frontend, Backend, Automation Agent images (tagged `sha` + `latest`).
4. Deploys each to its droplet via SSH + Docker Compose.

#### Droplet Prep (run once per droplet)

```bash
curl -fsSL https://get.docker.com | sh
```

Open firewall ports: `22`, `80`, `443`.

#### DNS Setup (Cloudflare or any provider)

Point each domain to the corresponding droplet IP as a plain **A record** (**DNS only** — no
Cloudflare proxy / orange cloud). SSL is handled on the droplet by Nginx + Let's Encrypt.

| Record | Type | Value | Proxy |
|--------|------|-------|-------|
| `frontdoor.tesbo.io` | A | `<FRONTEND_IP>` | DNS only |
| `backdoor.tesbo.io` | A | `<BACKEND_IP>` | DNS only |
| `automate.tesbo.io` | A | `<AGENT_IP>` | DNS only |

#### Verification

- Frontend: `https://frontdoor.tesbo.io/`
- Backend health: `https://backdoor.tesbo.io/health`
- Automation Agent: `https://automate.tesbo.io/health`

---

### 2. TesboX-Runner (Execution Service)

**Repo:** `Tesbo-Execution/` (separate git repo)
**Workflow:** `Tesbo-Execution/.github/workflows/deploy.yml` — manual trigger with target selector (`all`, `api-only`, `workers-only`)

#### Required GitHub Secrets (in TesboX-Runner repo)

| Secret | Description |
|--------|-------------|
| `CONTAINER_REGISTRY` | e.g. `registry.digitalocean.com/bettercases` |
| `REGISTRY_USERNAME` | DOCR username (usually a DO API token) |
| `REGISTRY_PASSWORD` | DOCR password / API token |
| `DO_API_TOKEN` | DigitalOcean API token (for K8s access) |
| `SSH_PRIVATE_KEY` | SSH key for API droplet |
| `EXECUTION_API_DROPLET_IP` | Execution API droplet IP |
| `DOKS_CLUSTER_NAME` | DigitalOcean Kubernetes cluster name |
| `DATABASE_URL` | Managed PostgreSQL connection string |
| `REDIS_URL` | Managed Redis connection string |

#### Deploy Flow

1. Add/update all GitHub secrets in the TesboX-Runner repo.
2. Trigger **Deploy TesboX-Runner** from GitHub Actions.
3. Select target: `all` (default), `api-only`, or `workers-only`.
4. Workflow:
   - Builds and pushes `tesbox-executions-api` and `tesbox-executions-worker` images
   - Deploys API to droplet via SSH + Docker Compose
   - Applies K8s manifests to DOKS cluster for worker autoscaling

#### K8s Setup (one-time)

1. Create the worker secret with managed Redis and API URLs:

```bash
kubectl create secret generic execution-worker-env \
  --namespace=tesbo-execution \
  --from-literal=REDIS_URL="rediss://default:pass@redis-host:25061" \
  --from-literal=EXECUTION_API_BASE_URL="http://api-droplet-ip" \
  --from-literal=QUEUE_PREFIX="bull" \
  --from-literal=QUEUE_NAME="execution-jobs" \
  --from-literal=PLAYWRIGHT_HEADLESS="true"
```

2. Install KEDA (if not already):

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda --namespace keda --create-namespace
```

3. Apply namespace: `kubectl apply -f infra/kubernetes/namespace.yaml`

#### Verification

- Execution API health: `http://<execution-api-ip>/health`
- Worker pods: `kubectl get pods -n tesbo-execution`
- KEDA ScaledObject: `kubectl get scaledobject -n tesbo-execution`

---

### Manual Redeploy

On any droplet, update `IMAGE_TAG` in `/opt/<service>/.env` then:

```bash
docker compose pull && docker compose up -d --remove-orphans
```

For K8s workers:

```bash
kubectl set image deployment/execution-worker \
  execution-worker=registry.digitalocean.com/bettercases/tesbox-executions-worker:<tag> \
  -n tesbo-execution
```

---

### Connecting TesboX ↔ TesboX-Runner

Set these on the TesboX Backend:

```
EXECUTION_SERVICE_BASE_URL=http://<execution-api-droplet-ip>:7420
EXECUTION_SERVICE_API_KEY=<your-api-key>
EXECUTION_SERVICE_WEBHOOK_URL=http://<backend-ip>/api/automation/callback
EXECUTION_SERVICE_WEBHOOK_SECRET=<your-webhook-secret>
```
