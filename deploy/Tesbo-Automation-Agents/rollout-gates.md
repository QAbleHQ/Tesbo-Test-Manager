# Automation Agent Progressive Rollout Gates

## Feature Flag Stages

1. `SESSION_REPOSITORY_MODE=memory`, `ENABLE_REDIS_SESSION_REPOSITORY=false`
2. `SESSION_REPOSITORY_MODE=dual-write`, `ENABLE_REDIS_SESSION_REPOSITORY=true`
3. `SESSION_REPOSITORY_MODE=redis`, `ENABLE_REDIS_SESSION_REPOSITORY=true`
4. Remove MJPEG dependency from clients after WebSocket stability target is met.

## Promotion Criteria Per Stage

- Canary script passes 5 consecutive runs.
- `/health` remains available through local and TLS endpoints.
- No sustained rise in `create_session_failed` or `ws_live_frame_failed` errors.
- OOM/restart alerts remain below baseline threshold for 24h.

## Rollback

- Set `SESSION_REPOSITORY_MODE=memory`.
- Keep `ENABLE_WEBSOCKET_LIVE_STREAM=true` for compatibility.
- Re-deploy automation-agent and verify canary before reopening traffic.
