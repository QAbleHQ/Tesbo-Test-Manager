FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p ./artifacts/screenshots ./artifacts/videos ./artifacts/traces ./artifacts/stagehand-cache

ENV PORT=7400
EXPOSE 7400

CMD ["node", "src/index.js"]
