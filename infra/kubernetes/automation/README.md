# Automation Execution Plane (K8s)

Deploys the queue-based test execution plane to DigitalOcean Kubernetes:

- `automation-api` — HTTP gateway for enqueue/cancel/stats (port 7410, LoadBalancer)
- `automation-worker` — BullMQ consumers running Playwright browser jobs (port 7411)
- `keda-trigger-auth` — KEDA authentication to TLS Redis
- `worker-scaledobject` — KEDA autoscaler: 0→50 workers based on Redis queue depth

## How It Connects to the Droplet Architecture

The backend runs on a **DigitalOcean droplet** (not in this cluster). Communication:

- **Backend droplet → automation-api**: via the LoadBalancer external IP (`http://<LB-IP>:7410`)
- **automation-worker → Backend droplet**: via `BACKEND_BASE_URL` (e.g. `http://<DROPLET-IP>:80`)
- **Both → Redis**: via DO Managed Redis (`rediss://...ondigitalocean.com:25061`)

## Secret Keys

Secret `automation-secrets` in `bettercases-automation` namespace:

| Key | Description |
|-----|-------------|
| `redis-url` | Full Redis connection URL (`rediss://...`) |
| `redis-password` | Redis password only (for KEDA trigger) |
| `backend-base-url` | Backend droplet URL (e.g. `http://DROPLET_IP:80`) |
| `queue-shared-token` | Must match backend `AUTOMATION_QUEUE_SHARED_TOKEN` |
| `agent-shared-token` | Must match backend `AUTOMATION_AGENT_SHARED_TOKEN` |

## After First Deploy

1. Get the LoadBalancer IP:

```bash
kubectl -n bettercases-automation get svc automation-api
```

2. Update the backend droplet config:

```
AUTOMATION_QUEUE_API_BASE_URL=http://<EXTERNAL-IP>:7410
```

3. Restart the backend container on the droplet to pick up the new URL.
