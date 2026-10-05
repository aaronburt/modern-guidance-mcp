FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && \
    find node_modules -name "*.map" -delete && \
    find node_modules -name "*.d.ts" -delete && \
    find node_modules -type d -name test -exec rm -rf {} + 2>/dev/null || true && \
    find node_modules -type d -name docs -exec rm -rf {} + 2>/dev/null || true

FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --chown=nonroot:nonroot server.mjs package.json ./
EXPOSE 8080
CMD ["server.mjs"]
