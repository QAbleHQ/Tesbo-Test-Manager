FROM maven:3.9.9-eclipse-temurin-17 AS builder
WORKDIR /build

COPY pom.xml ./
COPY src ./src

RUN mvn -DskipTests dependency:copy-dependencies package

FROM eclipse-temurin:17-jre AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r app && useradd -r -g app app

COPY --from=builder /build/target/backend-1.0.0-SNAPSHOT.jar /app/app.jar
COPY --from=builder /build/target/dependency /app/lib
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh && chown -R app:app /app

ENV JAVA_OPTS=""
EXPOSE 7000

USER app
ENTRYPOINT ["/app/docker-entrypoint.sh"]
