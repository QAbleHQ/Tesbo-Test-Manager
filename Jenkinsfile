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
        STAGE_ENV_CONFIG = 'tesbo-test-manager-stage-env'
        APP_DIR          = '/root/Tesbo-Test-Manager/Tesbo-Test-Manager'
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
                echo 'Deploying Tesbo stage (same server — no SSH)...'
                configFileProvider([configFile(fileId: "${STAGE_ENV_CONFIG}", targetLocation: '.env')]) {
                    sh """
                        sudo cp .env ${APP_DIR}/.env
                        sudo /usr/local/bin/tesbo-stage-deploy.sh
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
            echo 'Stage deploy completed successfully.'
        }
        failure {
            sh "sudo bash -c 'cd ${APP_DIR} && docker-compose logs --tail=60 backend frontend || true'"
        }
    }
}
