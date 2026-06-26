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
        // Credential IDs only — no hosts, paths, or secrets in Git.
        STAGE_SSH_CREDS  = 'tesbo-stage-ssh'
        STAGE_ENV_CONFIG = 'tesbo-test-manager-stage-env'
        STAGE_SSH_TARGET = credentials('tesbo-stage-ssh-target')
        STAGE_APP_DIR    = credentials('tesbo-stage-app-dir')
        STAGE_DEPLOY_CMD = credentials('tesbo-stage-deploy-script')
        STAGE_DEPLOY_LOG = credentials('tesbo-stage-deploy-log')
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
                echo 'Deploying Tesbo stage environment...'
                configFileProvider([configFile(fileId: "${STAGE_ENV_CONFIG}", targetLocation: '.env')]) {
                    sshagent(credentials: ["${STAGE_SSH_CREDS}"]) {
                        sh """
                            scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                                .env ${STAGE_SSH_TARGET}:${STAGE_APP_DIR}/.env

                            ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                                ${STAGE_SSH_TARGET} \\
                                '${STAGE_DEPLOY_CMD}'
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
            echo 'Stage deploy completed successfully.'
        }
        failure {
            sshagent(credentials: ["${STAGE_SSH_CREDS}"]) {
                sh """
                    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                        ${STAGE_SSH_TARGET} \\
                        'tail -60 ${STAGE_DEPLOY_LOG} || true'
                """
            }
        }
    }
}
