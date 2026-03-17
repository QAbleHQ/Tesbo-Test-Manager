# Automation Infra (Terraform)

This module creates a dedicated DigitalOcean Kubernetes cluster for the automation execution plane.

## What it provisions

- DOKS cluster with autoscaled node pool
- A logical Redis database in an existing DO managed Redis cluster

## Usage

```bash
cd infra/terraform/automation
terraform init
terraform apply \
  -var="do_token=$DO_TOKEN" \
  -var="redis_cluster_id=<existing-redis-cluster-id>"
```

After apply:

1. Export kubeconfig from `kube_config` output.
2. Install KEDA in the cluster.
3. Apply manifests from `infra/kubernetes/automation`.
