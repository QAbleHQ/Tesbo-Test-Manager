FROM node:26-bookworm-slim AS builder
WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# Bake the English OCR language data into the image at build time (from the npm registry,
# the same trust boundary as the rest of the dependency tree) so image-to-text extraction
# in the knowledge base works fully offline — no CDN call at request time.
RUN npm install --no-save @tesseract.js-data/eng@1.0.0 \
    && mkdir -p /app/tessdata \
    && cp node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz /app/tessdata/eng.traineddata.gz \
    && rm -rf node_modules/@tesseract.js-data

COPY --from=builder /build/dist ./dist
COPY migrations ./migrations

RUN mkdir -p /app/uploads && groupadd -r app && useradd -r -g app app && chown -R app:app /app
USER app

EXPOSE 7000
CMD ["node", "dist/main.js"]
