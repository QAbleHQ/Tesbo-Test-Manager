# Tesbo Execution Plane (Kubernetes)

Kubernetes manifests for the **test execution plane only**. The core application
(backend, frontend, automation-agents) runs on DigitalOcean droplets and is
deployed via the `deploy.yml` workflow + docker-compose.

## Architecture

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                    DigitalOcean Droplets                            │
  │                                                                     │
  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────────────┐ │
  │  │ Frontend       │  │ Backend        │  │ Automation-Agents     │ │
  │  │ :3000          │  │ :7000          │  │ :7400 (sessions/AI)   │ │
  │  │ frontdoor.     │  │ backdoor.      │  │ docker-compose        │ │
  │  │ tesbo.io       │  │ tesbo.io       │  │                       │ │
  │  └────────────────┘  └───────┬────────┘  └───────────────────────┘ │
  └──────────────────────────────┼─────────────────────────────────────┘
                                 │
                    AUTOMATION_QUEUE_API_BASE_URL
                    http://<LB-IP>:7410
                                 │
  ┌──────────────────────────────┼─────────────────────────────────────┐
  │                    DigitalOcean Kubernetes                          │
  │                    namespace: bettercases-automation                │
  │                                                                     │
  │            ┌─────────────────┴─────────────────┐                   │
  │            │  automation-api (:7410)            │                   │
  │            │  LoadBalancer service              │                   │
  │            │  enqueue / cancel / stats          │                   │
  │            └─────────────────┬─────────────────┘                   │
  │                              │                                      │
  │                     ┌────────┴────────┐                            │
  │                     │  Redis (BullMQ) │  ← DO Managed Redis        │
  │                     └────────┬────────┘                            │
  │                              │                                      │
  │            ┌─────────────────┴─────────────────┐                   │
  │            │  automation-worker (:7411)         │                   │
  │            │  KEDA-scaled 0 → 50 replicas       │                   │
  │            │  BullMQ consumers + Playwright     │                   │
  │            └───────────────────────────────────┘                   │
  └─────────────────────────────────────────────────────────────────────┘
```

## Communication Flow

| From | To | How |
|------|----|-----|
| Backend (droplet) | automation-api (K8s) | LoadBalancer external IP: `http://<LB-IP>:7410` |
| automation-worker (K8s) | Backend (droplet) | Droplet IP: `http://<BACKEND-IP>:80` |
| automation-api/worker | Redis | DO Managed Redis: `rediss://...ondigitalocean.com:25061` |

## Prerequisites

- DigitalOcean Kubernetes cluster
- [KEDA](https://keda.sh/) installed for worker autoscaling
- DigitalOcean Managed Redis
- Backend running on a droplet (reachable from K8s pods)

## Deploy via GitHub Actions (recommended)

The workflow `.github/workflows/deploy-k8s.yml` handles the full pipeline:

1. Builds and pushes the `tesbo-test-runner-agents` image to DOCR
2. Syncs secrets from GitHub Secrets to K8s
3. Applies all manifests (Service, Deployments, KEDA ScaledObject)
4. Sets image tag to the commit SHA
5. Prints the LoadBalancer external IP

### Required GitHub Secrets

See [`GITHUB_SECRETS.md`](GITHUB_SECRETS.md) for the full list.

### After First Deploy

The LoadBalancer will get an external IP (takes ~1-2 minutes). Find it with:

```bash
kubectl -n bettercases-automation get svc automation-api
```

Then set this on your **backend droplet**:

```
AUTOMATION_QUEUE_API_BASE_URL=http://<EXTERNAL-IP>:7410
```

## Manual Deployment

```bash
# 1. Namespace
kubectl apply -f infra/kubernetes/automation/namespace.yaml

# 2. Pull secret
kubectl -n bettercases-automation create secret docker-registry docr-registry \
  --docker-server=registry.digitalocean.com \
  --docker-username=YOUR_DOCR_TOKEN \
  --docker-password=YOUR_DOCR_TOKEN

# 3. App secrets
kubectl apply -f infra/kubernetes/automation/secret.yaml

# 4. Deploy
kubectl apply -f infra/kubernetes/automation/api-service.yaml
kubectl apply -f infra/kubernetes/automation/api-deployment.yaml
kubectl apply -f infra/kubernetes/automation/worker-deployment.yaml
kubectl apply -f infra/kubernetes/automation/keda-trigger-auth.yaml
kubectl apply -f infra/kubernetes/automation/worker-scaledobject.yaml
```

## Scaling

| Service | Strategy | Details |
|---------|----------|---------|
| automation-api | Manual | `kubectl -n bettercases-automation scale deploy/automation-api --replicas=N` |
| automation-worker | **KEDA autoscale** | 0→50 replicas based on Redis queue depth (`bull:automation-execution-jobs:wait` list length) |

## File Structure

```
infra/kubernetes/
├── README.md
├── GITHUB_SECRETS.md
└── automation/
    ├── namespace.yaml              # bettercases-automation namespace
    ├── secret.yaml                 # Secret template (Redis, tokens)
    ├── api-deployment.yaml         # Queue API (2 replicas)
    ├── api-service.yaml            # LoadBalancer :7410
    ├── worker-deployment.yaml      # Workers (KEDA-scaled, 0 base)
    ├── keda-trigger-auth.yaml      # KEDA → Redis auth
    └── worker-scaledobject.yaml    # KEDA Redis trigger
```
