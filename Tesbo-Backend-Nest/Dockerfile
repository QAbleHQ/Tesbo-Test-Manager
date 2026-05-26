FROM node:22-bookworm-slim AS builder
WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /build/dist ./dist

RUN groupadd -r app && useradd -r -g app app && chown -R app:app /app
USER app

EXPOSE 7000
CMD ["node", "dist/main.js"]
