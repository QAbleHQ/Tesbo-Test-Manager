# GitHub Secrets for K8s Execution Plane Deployment

These secrets must be configured in your GitHub repository settings
(**Settings > Secrets and variables > Actions**) for the `deploy-k8s.yml` workflow.

## Required Secrets

### DigitalOcean Infrastructure

| Secret | Description | Example |
|--------|-------------|---------|
| `DO_API_TOKEN` | DigitalOcean API token (also used as DOCR username/password) | `dop_v1_...` |
| `DO_K8S_CLUSTER_NAME` | Name of your DOKS cluster | `tesbox-execute-kubernets` |

### Container Registry

| Secret | Description | Example |
|--------|-------------|---------|
| `DOCR_REGISTRY` | Full DOCR registry URL | `registry.digitalocean.com/bettercases` |
| `DOCR_REPO_AUTOMATION` | Test-runner-agents image repo name | `tesbo-test-runner-agents` |

### Redis

| Secret | Description | Example |
|--------|-------------|---------|
| `REDIS_URL` | Full Redis connection URL | `rediss://default:PASS@host:25061` |
| `REDIS_PASSWORD` | Redis password only (for KEDA trigger auth) | `AVNS_...` |

### Backend Droplet

| Secret | Description | Example |
|--------|-------------|---------|
| `BACKEND_BASE_URL` | Backend droplet URL (reachable from K8s pods) | `http://123.45.67.89:80` |

### Shared Tokens

| Secret | Description | Notes |
|--------|-------------|-------|
| `AGENT_SHARED_TOKEN` | Token for agent API auth | Must match backend droplet config |
| `AUTOMATION_QUEUE_SHARED_TOKEN` | Token for queue API auth | Must match backend droplet config |

## Secrets You Already Have (from `deploy.yml`)

These are already configured if you've been using the droplet deploy workflow:

- `DO_API_TOKEN`
- `DOCR_REGISTRY`
- `DOCR_REPO_AUTOMATION`
- `AGENT_SHARED_TOKEN`
- `AUTOMATION_QUEUE_SHARED_TOKEN`
- `REDIS_URL`

## New Secrets to Add

| Secret | How to get the value |
|--------|---------------------|
| `DO_K8S_CLUSTER_NAME` | `tesbox-execute-kubernets` |
| `REDIS_PASSWORD` | Extract from your `REDIS_URL` (the part between `:` and `@`) |
| `BACKEND_BASE_URL` | Your backend droplet IP: `http://<DROPLET_BACKEND_IP>:80` |

## After First Deploy

Once the automation-api LoadBalancer gets an external IP, update your
**backend droplet** config with:

```
AUTOMATION_QUEUE_API_BASE_URL=http://<LOADBALANCER-IP>:7410
```

Find the IP:

```bash
kubectl -n bettercases-automation get svc automation-api \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```
