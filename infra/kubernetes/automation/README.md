# Automation Execution Plane (K8s)

This folder deploys the queue-based execution plane as separate services:

- `automation-api` (enqueue/cancel/stats API gateway)
- `automation-worker` (queue consumers only)
- `ScaledObject` for autoscaling workers from Redis queue depth

## Prerequisites

- Kubernetes cluster
- [KEDA](https://keda.sh/) installed
- Redis reachable by worker pods and KEDA trigger
- Secret `automation-secrets` in `bettercases-automation` namespace

Required secret keys:

- `redis-url`
- `backend-base-url`
- `queue-shared-token`
- `agent-shared-token`

## Apply

```bash
kubectl apply -f infra/kubernetes/automation/namespace.yaml
kubectl -n bettercases-automation create secret generic automation-secrets \
  --from-literal=redis-url='redis://redis:6379' \
  --from-literal=backend-base-url='http://backend.default.svc.cluster.local:7000' \
  --from-literal=queue-shared-token='change-me' \
  --from-literal=agent-shared-token='change-me'
kubectl apply -f infra/kubernetes/automation/api-deployment.yaml
kubectl apply -f infra/kubernetes/automation/api-service.yaml
kubectl apply -f infra/kubernetes/automation/worker-deployment.yaml
kubectl apply -f infra/kubernetes/automation/worker-scaledobject.yaml
```

## Important

- Update image references (`REPLACE_ME`) before apply.
- Set `worker-scaledobject.yaml` `address` to your Redis endpoint.
- Backend should use `AUTOMATION_QUEUE_API_BASE_URL=http://automation-api.bettercases-automation.svc.cluster.local:7400`.
- If you change queue prefix or queue name, update `worker-scaledobject.yaml` `listName` to match:
  - `<prefix>:<queueName>:wait` (example: `bull:automation-execution-jobs:wait`).
