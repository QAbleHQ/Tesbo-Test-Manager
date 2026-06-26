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
        // App server where stage.tesbo.io runs (Docker + repo live here).
        STAGE_SERVER_HOST = '208.87.133.122'
        STAGE_SERVER_USER = 'root'
        DEPLOY_SCRIPT     = '/usr/local/bin/tesbo-stage-deploy.sh'
        DEPLOY_LOG        = '/var/log/tesbo-stage-deploy.log'
        STAGE_URL         = 'https://stage.tesbo.io'
        // Jenkins credential ID for SSH private key (Manage Jenkins → Credentials).
        STAGE_SSH_CREDS   = 'tesbo-stage-ssh'
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
                echo "Jenkins → SSH → ${STAGE_SERVER_USER}@${STAGE_SERVER_HOST} → ${STAGE_URL}"
                sshagent(credentials: ["${STAGE_SSH_CREDS}"]) {
                    sh """
                        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
                            ${STAGE_SERVER_USER}@${STAGE_SERVER_HOST} \\
                            '${DEPLOY_SCRIPT}'
                    """
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
