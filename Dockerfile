FROM node:22-alpine3.24 AS builder

WORKDIR /app

# better-sqlite3 13.x ships no musl prebuilt binary yet; compile it from source here
# so the final stage stays free of build tools.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine3.24

LABEL org.opencontainers.image.title="ocpp-cp-admin" \
      org.opencontainers.image.description="Administration and monitoring dashboard for OCPP charge points" \
      org.opencontainers.image.url="https://github.com/WoCha-FR/ocpp-cp-admin" \
      org.opencontainers.image.source="https://github.com/WoCha-FR/ocpp-cp-admin" \
      org.opencontainers.image.documentation="https://github.com/WoCha-FR/ocpp-cp-admin#readme" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="1.0.0"

WORKDIR /app
ENV NODE_ENV=production

# Create non-root user first so we can copy files directly with target ownership.
# openssl is required at runtime to generate/manage the client certificate authority (mTLS).
RUN addgroup -S app && adduser -S app -G app \
    && apk add --no-cache su-exec openssl

COPY --chown=app:app package*.json ./
COPY --chown=app:app --from=builder /app/node_modules ./node_modules

COPY --chown=app:app src ./src
COPY --chown=app:app locales ./locales
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app public ./public
COPY --chown=app:app config ./config
COPY --chown=app:app scripts ./scripts

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Keep a copy of initial content to seed empty mounted volumes at startup.
RUN mkdir -p /opt/defaults/config /opt/defaults/config/legal /opt/defaults/config/certs /opt/defaults/public-img \
    && cp /app/config/config.sample.json /opt/defaults/config/config.sample.json \
    && cp /app/config/legal/*.sample.md /opt/defaults/config/legal/ \
    && cp /app/config/certs/isrg-root-x1.pem /opt/defaults/config/certs/isrg-root-x1.pem \
    && cp -a /app/public/img/. /opt/defaults/public-img/ \
    && mkdir -p /app/logs /app/public/img /app/locales-custom \
    && chown -R app:app /opt/defaults /app/logs /app/public/img /app/locales-custom \
    && chown app:app /usr/local/bin/docker-entrypoint.sh \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/config", "/app/logs"]

EXPOSE 3000 3001 9000 9001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:3000/healthz',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1);});"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
