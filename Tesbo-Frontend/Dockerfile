FROM node:20-alpine AS deps
WORKDIR /app

ARG NEXT_PUBLIC_API_URL=http://localhost:7000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN mkdir -p public
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ARG NEXT_PUBLIC_API_URL=http://localhost:7000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/public ./public
COPY --from=deps /app/.next ./.next
COPY --from=deps /app/instrumentation.mjs ./instrumentation.mjs

ENV NODE_OPTIONS="--import ./instrumentation.mjs"

EXPOSE 3000

CMD ["npm", "run", "start"]
