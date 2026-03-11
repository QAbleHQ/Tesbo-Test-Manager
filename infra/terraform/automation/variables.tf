variable "do_token" {
  description = "DigitalOcean API token"
  type        = string
  sensitive   = true
}

variable "cluster_name" {
  description = "Automation Kubernetes cluster name"
  type        = string
  default     = "bettercases-automation"
}

variable "region" {
  description = "DigitalOcean region slug"
  type        = string
  default     = "blr1"
}

variable "k8s_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.31.1-do.3"
}

variable "node_size" {
  description = "Kubernetes node size"
  type        = string
  default     = "s-4vcpu-8gb"
}

variable "node_count" {
  description = "Initial node count"
  type        = number
  default     = 2
}

variable "min_nodes" {
  description = "Minimum autoscaled nodes"
  type        = number
  default     = 1
}

variable "max_nodes" {
  description = "Maximum autoscaled nodes"
  type        = number
  default     = 10
}

variable "redis_cluster_id" {
  description = "Existing managed Redis cluster id"
  type        = string
}
