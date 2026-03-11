output "cluster_id" {
  value = digitalocean_kubernetes_cluster.automation.id
}

output "cluster_name" {
  value = digitalocean_kubernetes_cluster.automation.name
}

output "kube_config" {
  value     = digitalocean_kubernetes_cluster.automation.kube_config[0].raw_config
  sensitive = true
}
