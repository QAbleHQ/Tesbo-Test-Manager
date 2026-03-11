# Test Infrastructure Phases (Implemented)

This project now includes all three foundational phases for a HyperExecute-style execution plane.

## Phase 1: Separate queue-backed execution service

- Queue-backed automation execution is active (`automation_runs` + `automation_jobs`).
- Backend enqueues jobs to automation service queue API.
- Worker callback lifecycle is persisted (`start`, `heartbeat`, `complete`, `fail`).

## Phase 2: Distributed worker model and autoscaling hooks

- Automation service supports split runtime roles:
  - `AUTOMATION_SERVICE_ROLE=api`
  - `AUTOMATION_SERVICE_ROLE=worker`
- Queue service and workers are deployable independently.
- K8s manifests + KEDA scaffold are provided in `infra/kubernetes/automation`.
- Terraform scaffold for dedicated automation cluster is provided in `infra/terraform/automation`.

## Phase 3: Production orchestration controls

- Admission control for project queue pressure:
  - max active runs per project
  - max queued jobs per project
- Duration-aware shard assignment for improved parallel balancing.
- Autoscaling recommendation endpoint:
  - `GET /api/internal/automation/autoscaling-recommendation`
