// Auto-deploy on main + SonarQube scan before deploy.
// Sonar secrets: Jenkins Managed file id = tesbo-test-manager-env
// Sonar failure does NOT block deploy (catchError).
//
// Blue/green prod deploy (near-zero downtime) — all logic lives in this Jenkinsfile:
//   - Live color keeps serving while the idle color is built + started
//   - Health must pass on the NEW color before host nginx (systemctl) switches
//   - Path: Cloudflare/public -> host nginx (:80/:443) -> blue/green app ports
//   - On cutover failure: roll nginx back to previous color (no public downtime)
//   - Never: docker compose down -v (DB/volumes untouched)
//
// Ports (prod host app-tesbo / DEPLOY_HOST=tesbo):
//   blue  -> FE 1020 / BE 1021 / Redis host 6389  (current live baseline)
//   green -> FE 1030 / BE 1031 / Redis host 6390
//
// Source branch: main. Target: https://app.tesbo.io + https://api-app.tesbo.io
// Stage uses Jenkinsfile.stage -> app-stage.tesbo.io

pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    // Use SSH so prod deploy key works (HTTPS breaks non-interactive git fetch).
    REPO_URL          = 'git@github.com:QAbleHQ/Tesbo-Test-Manager-Private.git'
    APP_HEALTH        = 'https://app.tesbo.io'
    API_HEALTH        = 'https://api-app.tesbo.io'
    FRONTEND_DOMAIN   = 'app.tesbo.io'
    BACKEND_DOMAIN    = 'api-app.tesbo.io'
    DEPLOY_HOST       = 'tesbo'
    DEPLOY_USER       = 'root'
    DEPLOY_PATH       = '/opt/tesbo-test-manager/Tesbo-Test-Manager'
    COMPOSE_BASE      = 'tesbo-test-manager'
    LEGACY_COMPOSE    = 'tesbo-test-manager'
    ACTIVE_COLOR_FILE = '/opt/tesbo-test-manager/Tesbo-Test-Manager/.active-color'
    BLUE_FE_PORT      = '1020'
    BLUE_BE_PORT      = '1021'
    BLUE_REDIS_PORT   = '6389'
    GREEN_FE_PORT     = '1030'
    GREEN_BE_PORT     = '1031'
    GREEN_REDIS_PORT  = '6390'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        script {
          env.GIT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
          echo "Pipeline ${env.GIT_SHA} -> prod blue/green deploy ${env.DEPLOY_USER}@${env.DEPLOY_HOST}:${env.DEPLOY_PATH}"
        }
      }
    }

    stage('SonarQube') {
      steps {
        catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE') {
          configFileProvider([
            configFile(fileId: 'tesbo-test-manager-env', variable: 'TESBO_ENV_FILE')
          ]) {
            sh '''
              set -eu
              set -a
              # shellcheck disable=SC1090
              . "$TESBO_ENV_FILE"
              set +a

              test -n "${SONAR_HOST_URL:-}" || { echo "SONAR_HOST_URL missing in tesbo-test-manager-env"; exit 1; }
              test -n "${SONAR_TOKEN:-}" || { echo "SONAR_TOKEN missing in tesbo-test-manager-env"; exit 1; }

              echo "==> SonarQube scan -> ${SONAR_HOST_URL}"
              docker run --rm \
                -e SONAR_HOST_URL="${SONAR_HOST_URL}" \
                -e SONAR_TOKEN="${SONAR_TOKEN}" \
                -v "${WORKSPACE}:/usr/src" \
                -w /usr/src \
                sonarsource/sonar-scanner-cli:11 \
                -Dsonar.projectBaseDir=/usr/src
            '''
          }
        }
      }
    }

    stage('Deploy prod (blue/green)') {
      steps {
        // IMPORTANT: use <<'ENDSSH' (quoted). Unquoted heredocs break under Jenkins durable
        // task / dash and can execute the deploy body on the Jenkins agent instead of prod.
        // Pass config via remote env; body uses normal $VAR syntax on the prod host.
        sh '''
          set -eu
          SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
          echo "==> Jenkins user: $(whoami)"
          ssh $SSH_OPTS "${DEPLOY_USER}@${DEPLOY_HOST}" "hostname && test -d ${DEPLOY_PATH} && test -f ${DEPLOY_PATH}/.env"

          ssh $SSH_OPTS "${DEPLOY_USER}@${DEPLOY_HOST}" \
            "env \
              DEPLOY_PATH=${DEPLOY_PATH} \
              REPO_URL=${REPO_URL} \
              FRONTEND_DOMAIN=${FRONTEND_DOMAIN} \
              BACKEND_DOMAIN=${BACKEND_DOMAIN} \
              COMPOSE_BASE=${COMPOSE_BASE} \
              LEGACY_COMPOSE=${LEGACY_COMPOSE} \
              ACTIVE_COLOR_FILE=${ACTIVE_COLOR_FILE} \
              BLUE_FE_PORT=${BLUE_FE_PORT} \
              BLUE_BE_PORT=${BLUE_BE_PORT} \
              BLUE_REDIS_PORT=${BLUE_REDIS_PORT} \
              GREEN_FE_PORT=${GREEN_FE_PORT} \
              GREEN_BE_PORT=${GREEN_BE_PORT} \
              GREEN_REDIS_PORT=${GREEN_REDIS_PORT} \
              bash -s" <<'ENDSSH'
set -eu
cd "$DEPLOY_PATH"
test -f .env || { echo "MISSING .env - refusing to deploy"; exit 1; }

git remote set-url origin "$REPO_URL"
git fetch origin main
git checkout -f main
git reset --hard origin/main
git log -1 --oneline
# docker-compose.yml threads GIT_SHA into the backend (/health, MCP serverInfo.version). Stage gets
# it from Jenkins' own env; this remote shell never did, so prod always reported "local".
export GIT_SHA="$(git rev-parse --short HEAD)"
# The daily Basecamp analytics report runs in PRODUCTION ONLY. docker-compose.yml defaults this to
# false; this shell export is what turns it on here (it overrides .env for compose interpolation) and
# Jenkinsfile.stage deliberately does not set it. BASECAMP_* credentials still come from the server .env.
export ANALYTICS_REPORT_ENABLED=true

if [ -f "$ACTIVE_COLOR_FILE" ]; then
  ACTIVE="$(tr -d '[:space:]' < "$ACTIVE_COLOR_FILE" | tr '[:upper:]' '[:lower:]')"
else
  ACTIVE="blue"
  if docker compose -p "$LEGACY_COMPOSE" ps -q 2>/dev/null | grep -q .; then
    echo "==> Legacy project ${LEGACY_COMPOSE} is running; treating as active=blue"
  fi
  echo "$ACTIVE" > "$ACTIVE_COLOR_FILE"
fi

case "$ACTIVE" in
  blue)  TARGET="green" ;;
  green) TARGET="blue"  ;;
  *) echo "Invalid ACTIVE_COLOR='${ACTIVE}' in ${ACTIVE_COLOR_FILE}"; exit 1 ;;
esac

if [ "$TARGET" = "blue" ]; then
  TARGET_FE="$BLUE_FE_PORT"
  TARGET_BE="$BLUE_BE_PORT"
  TARGET_REDIS="$BLUE_REDIS_PORT"
  PREV_FE="$GREEN_FE_PORT"
  PREV_BE="$GREEN_BE_PORT"
else
  TARGET_FE="$GREEN_FE_PORT"
  TARGET_BE="$GREEN_BE_PORT"
  TARGET_REDIS="$GREEN_REDIS_PORT"
  PREV_FE="$BLUE_FE_PORT"
  PREV_BE="$BLUE_BE_PORT"
fi

TARGET_PROJECT="${COMPOSE_BASE}-${TARGET}"
ACTIVE_PROJECT="${COMPOSE_BASE}-${ACTIVE}"

echo "==> Active=${ACTIVE} (keep up)  Target=${TARGET} FE=${TARGET_FE} BE=${TARGET_BE}"

export FRONTEND_PORT="$TARGET_FE"
export BACKEND_PORT="$TARGET_BE"
export REDIS_PORT="$TARGET_REDIS"

echo "==> Building ${TARGET_PROJECT} (live ${ACTIVE} stays UP; DB untouched)"
docker compose -p "$TARGET_PROJECT" build

echo "==> Starting ${TARGET_PROJECT}"
docker compose -p "$TARGET_PROJECT" up -d --remove-orphans

echo "==> Waiting for target health"
ok=0
i=1
while [ "$i" -le 36 ]; do
  if curl -fsS "http://127.0.0.1:${TARGET_BE}/health" >/dev/null 2>&1 \
    && curl -fsS -o /dev/null "http://127.0.0.1:${TARGET_FE}/" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 5
  i=$((i + 1))
done

docker compose -p "$TARGET_PROJECT" ps || true

if [ "$ok" -ne 1 ]; then
  echo "ERROR: target ${TARGET} failed health checks - leaving nginx on ${ACTIVE}"
  curl -fsS "http://127.0.0.1:${TARGET_BE}/health" || true
  curl -fsS -o /dev/null -w "frontend_local:%{http_code}\n" "http://127.0.0.1:${TARGET_FE}/" || true
  docker compose -p "$TARGET_PROJECT" down --remove-orphans || true
  exit 1
fi

echo "==> Target healthy; switching host nginx ${FRONTEND_DOMAIN}->${TARGET_FE}, ${BACKEND_DOMAIN}->${TARGET_BE}"
switch_host_nginx_port() {
  domain="$1"
  port="$2"
  conf=""
  for candidate in \
    "/etc/nginx/sites-available/${domain}" \
    "/etc/nginx/sites-enabled/${domain}"; do
    if [ -f "$candidate" ]; then
      conf="$(readlink -f "$candidate")"
      break
    fi
  done
  if [ -z "$conf" ]; then
    echo "MISSING host nginx site config for ${domain}"
    exit 1
  fi
  echo "    ${domain}: ${conf} -> 127.0.0.1:${port}"
  # Use [.] for dots — Groovy sh blocks reject backslash-dot escapes
  if grep -qE 'proxy_pass[[:space:]]+http://127[.]0[.]0[.]1:[0-9]+' "$conf"; then
    sed -i -E "s#(proxy_pass[[:space:]]+http://127[.]0[.]0[.]1:)[0-9]+#\\1${port}#g" "$conf"
  else
    echo "No proxy_pass http://127.0.0.1:PORT in ${conf}"
    exit 1
  fi
}

switch_host_nginx_port "$FRONTEND_DOMAIN" "$TARGET_FE"
switch_host_nginx_port "$BACKEND_DOMAIN" "$TARGET_BE"

nginx -t
systemctl reload nginx

echo "==> Verifying nginx cutover before stopping old stack"
edge_ok=0
i=1
while [ "$i" -le 12 ]; do
  fe_code="$(curl -skS -o /dev/null -w "%{http_code}" --resolve "${FRONTEND_DOMAIN}:443:127.0.0.1" "https://${FRONTEND_DOMAIN}/login" || true)"
  be_code="$(curl -skS -o /dev/null -w "%{http_code}" --resolve "${BACKEND_DOMAIN}:443:127.0.0.1" "https://${BACKEND_DOMAIN}/health" || true)"
  echo "    nginx check #${i}: fe=${fe_code} be=${be_code}"
  if [ "$fe_code" = "200" ] && [ "$be_code" = "200" ]; then
    edge_ok=1
    break
  fi
  sleep 2
  i=$((i + 1))
done
if [ "$edge_ok" -ne 1 ]; then
  echo "ERROR: nginx still unhealthy after switch - rolling nginx back to ${ACTIVE} (${PREV_FE}/${PREV_BE})"
  switch_host_nginx_port "$FRONTEND_DOMAIN" "$PREV_FE"
  switch_host_nginx_port "$BACKEND_DOMAIN" "$PREV_BE"
  nginx -t
  systemctl reload nginx
  echo "Nginx restored to previous color; NOT stopping old stack"
  exit 1
fi

echo "$TARGET" > "$ACTIVE_COLOR_FILE"
echo "==> ACTIVE_COLOR -> ${TARGET}"

echo "==> Stopping previous color / legacy stack (volumes kept; DB untouched)"
docker compose -p "$ACTIVE_PROJECT" down --remove-orphans || true
if docker compose -p "$LEGACY_COMPOSE" ps -q 2>/dev/null | grep -q .; then
  echo "==> Stopping legacy ${LEGACY_COMPOSE}"
  docker compose -p "$LEGACY_COMPOSE" down --remove-orphans || true
fi

curl -fsS "http://127.0.0.1:${TARGET_BE}/health" || true
curl -fsS -o /dev/null -w "frontend_local:%{http_code}\n" "http://127.0.0.1:${TARGET_FE}/" || true
echo "Blue/green deploy finished: live=${TARGET} fe=${TARGET_FE} be=${TARGET_BE} (was ${ACTIVE} on ${PREV_FE}/${PREV_BE})"
ENDSSH
        '''
      }
    }

    stage('Smoke check') {
      steps {
        sh '''
          set -eu
          fe="$(curl -sS -o /dev/null -w "%{http_code}" "${APP_HEALTH}/login" || true)"
          if [ "$fe" != "200" ]; then
            fe="$(curl -sS -o /dev/null -w "%{http_code}" "${APP_HEALTH}/" || true)"
          fi
          be="$(curl -sS -o /dev/null -w "%{http_code}" "${API_HEALTH}/health" || true)"
          echo "frontend:${fe}"
          echo "backend:${be}"
          SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
          if ssh $SSH_OPTS "${DEPLOY_USER}@${DEPLOY_HOST}" "test -f ${ACTIVE_COLOR_FILE}"; then
            echo "Active color: $(ssh $SSH_OPTS "${DEPLOY_USER}@${DEPLOY_HOST}" "cat ${ACTIVE_COLOR_FILE}")"
          fi
          echo "Site: ${APP_HEALTH}/projects"
          test "$fe" = "200" || { echo "Smoke failed: frontend HTTP ${fe}"; exit 1; }
          test "$be" = "200" || { echo "Smoke failed: backend HTTP ${be}"; exit 1; }
        '''
      }
    }
  }

  post {
    success {
      echo "OK: ${env.GIT_SHA} blue/green deploy -> https://app.tesbo.io/projects"
    }
    unstable {
      echo "Deploy may have succeeded but Sonar was UNSTABLE."
    }
    failure {
      echo "Failed. Prod only - stage was not touched. Nginx should still point at previous color."
    }
  }
}
