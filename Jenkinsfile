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
        MAIN_ENV_CONFIG = 'tesbo-test-manager-main-env'
        APP_DIR         = '/opt/tesbo-test-manager/Tesbo-Test-Manager'
    }

    stages {
        stage('Deploy main branch') {
            when {
                anyOf {
                    branch 'main'
                    expression { env.GIT_BRANCH == 'origin/main' }
                    expression { env.BRANCH_NAME == 'main' }
                }
            }
            steps {
                echo 'Deploying Tesbo main on same server...'
                configFileProvider([configFile(fileId: "${MAIN_ENV_CONFIG}", targetLocation: '.env')]) {
                    sh """
                        set -e
                        cd ${APP_DIR}
                        sudo git fetch origin
                        sudo git checkout main
                        sudo git pull origin main
                        sudo cp ${WORKSPACE}/.env ${APP_DIR}/.env
                        sudo chmod 600 ${APP_DIR}/.env
                        sudo docker compose up --build -d
                    """
                }
            }
        }

        stage('Skip non-main branch') {
            when {
                not {
                    anyOf {
                        branch 'main'
                        expression { env.GIT_BRANCH == 'origin/main' }
                        expression { env.BRANCH_NAME == 'main' }
                    }
                }
            }
            steps {
                echo 'Skipping deploy - this job only deploys the main branch.'
            }
        }
    }

    post {
        success {
            echo 'Main deploy completed successfully.'
        }
        failure {
            sh "sudo bash -c 'cd ${APP_DIR} && docker compose logs --tail=60 backend frontend migrator || true'"
        }
    }
}
