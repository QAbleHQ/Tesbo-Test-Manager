#!/bin/bash
cd /c/Users/Unity0080/Downloads/Tesbo-Test-Manager-Private/e2e
echo '=== e2e run 20260908-120004 — workers=10 ==='
echo 'specs: ui/requirements.spec.ts'
echo 'log:   /c/Users/Unity0080/Downloads/Tesbo-Test-Manager-Private/e2e/.run-logs/20260908-120004.log'
echo
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test ui/requirements.spec.ts --workers=10 2>&1 | tee /c/Users/Unity0080/Downloads/Tesbo-Test-Manager-Private/e2e/.run-logs/20260908-120004.log
echo
echo '=== run finished — exit $? ==='
