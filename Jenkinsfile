pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timeout(time: 30, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    triggers {
        githubPush()
    }

    environment {
        REMOTE_HOST    = 'tesbo-prod-deploy'
        REMOTE_APP_DIR = '/opt/tesbo-test-manager/Tesbo-Test-Manager'
        SSH_CONFIG     = '/var/lib/jenkins/.ssh/config_tesbo_prod'
    }

    stages {
        stage('Deploy master branch') {
            when {
                anyOf {
                    branch 'master'
                    expression { env.GIT_BRANCH == 'origin/master' }
                    expression { env.BRANCH_NAME == 'master' }
                }
            }
            steps {
                echo 'Deploying Tesbo master over dedicated SSH config...'
                checkout scm
                sh '''
                    set -e
                    test -f "${SSH_CONFIG}"

                    tar \
                      --exclude=.git \
                      --exclude=node_modules \
                      --exclude=.next \
                      --exclude=.env \
                      --exclude=docker-compose.yml \
                      --exclude=infra/docker/postgres/pg_hba.conf \
                      --exclude=Jenkinsfile \
                      -czf - . | \
                    ssh -F "${SSH_CONFIG}" ${REMOTE_HOST} "cd '${REMOTE_APP_DIR}' && tar -xzf -"

                    ssh -F "${SSH_CONFIG}" ${REMOTE_HOST} "
                      set -e
                      cd '${REMOTE_APP_DIR}'
                      docker compose up --build -d --wait --wait-timeout 300
                      docker compose ps
                      curl -fsS http://127.0.0.1:1011/health
                      curl -fsS -o /dev/null http://127.0.0.1:1010/
                    "
                '''
            }
        }

        stage('Skip non-master branch') {
            when {
                not {
                    anyOf {
                        branch 'master'
                        expression { env.GIT_BRANCH == 'origin/master' }
                        expression { env.BRANCH_NAME == 'master' }
                    }
                }
            }
            steps {
                echo 'Skipping deploy - this job only deploys the master branch.'
            }
        }
    }

    post {
        success {
            echo 'Master deploy completed successfully.'
        }
        failure {
            sh '''
                ssh -F "${SSH_CONFIG}" ${REMOTE_HOST} "
                  cd '${REMOTE_APP_DIR}' && docker compose logs --tail=60 backend frontend migrator || true
                " || true
            '''
        }
    }
}
