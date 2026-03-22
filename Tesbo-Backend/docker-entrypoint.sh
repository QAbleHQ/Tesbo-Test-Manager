#!/usr/bin/env sh
set -e

exec java $JAVA_OPTS -cp "/app/app.jar:/app/lib/*" com.bettercases.Main
