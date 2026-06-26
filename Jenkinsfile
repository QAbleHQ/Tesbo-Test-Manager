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
        STAGE_SERVER_HOST = '208.87.133.122'
        STAGE_SERVER_USER = 'root'
        APP_DIR           = '/root/Tesbo-Test-Manager/Tesbo-Test-Manager'
        DEPLOY_SCRIPT     = '/usr/local/bin/tesbo-stage-deploy.sh'
        DEPLOY_LOG        = '/var/log/tesbo-stage-deploy.log'
        STAGE_URL         = 'https://stage.tesbo.io'
        STAGE_SSH_CREDS   = 'tesbo-stage-ssh'
        // Jenkins → Manage Jenkins → Managed files (Config File Provider).
        STAGE_ENV_CONFIG  = 'tesbo-test-manager-stage-env'
    }

    stages {
        stage('Deploy stage branch') {
            when {
                anyOf {
                    branch 'stage'
                    expression { env.GIT_BRANCH == 'origin/stage' }
                    expression { env.BRANCH_NAME == 'stage' }
                }
            }
            steps {
                echo "Deploy ${STAGE_URL} via ${STAGE_SERVER_USER}@${STAGE_SERVER_HOST}"
                configFileProvider([configFile(fileId: "${STAGE_ENV_CONFIG}", targetLocation: '.env')]) {
                    sshagent(credentials: ["${STAGE_SSH_CREDS}"]) {
                        sh """
                            scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                                .env ${STAGE_SERVER_USER}@${STAGE_SERVER_HOST}:${APP_DIR}/.env

                            ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                                ${STAGE_SERVER_USER}@${STAGE_SERVER_HOST} \\
                                '${DEPLOY_SCRIPT}'
                        """
                    }
                }
            }
        }

        stage('Skip non-stage branch') {
            when {
                not {
                    anyOf {
                        branch 'stage'
                        expression { env.GIT_BRANCH == 'origin/stage' }
                        expression { env.BRANCH_NAME == 'stage' }
                    }
                }
            }
            steps {
                echo 'Skipping deploy — this job only deploys the stage branch.'
            }
        }
    }

    post {
        success {
            echo "Live updated: ${STAGE_URL}"
        }
        failure {
            sshagent(credentials: ["${STAGE_SSH_CREDS}"]) {
                sh """
                    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                        ${STAGE_SERVER_USER}@${STAGE_SERVER_HOST} \\
                        'tail -60 ${DEPLOY_LOG} || true'
                """
            }
        }
    }
}
