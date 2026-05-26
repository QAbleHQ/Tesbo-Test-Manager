$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Starting Tesbo frontend, Nest backend, and database with Docker Compose..."
docker compose up --build -d

Write-Host ""
Write-Host "Tesbo is starting."
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend health: http://localhost:7000/health"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  docker compose logs -f"
Write-Host "  docker compose down"
