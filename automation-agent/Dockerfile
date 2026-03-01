FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY artifacts ./artifacts

ENV PORT=7400
EXPOSE 7400

CMD ["node", "src/index.js"]
