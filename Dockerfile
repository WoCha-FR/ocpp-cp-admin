FROM node:22-alpine3.22

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
RUN addgroup -S app && adduser -S app -G app

# Install runtime dependencies first for better layer caching.
COPY --chown=app:app package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=app:app src ./src
COPY --chown=app:app locales ./locales
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app public ./public
COPY --chown=app:app config ./config

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Keep a copy of initial content to seed empty mounted volumes at startup.
RUN mkdir -p /opt/defaults/config /opt/defaults/public-img \
    && cp /app/config/config.sample.json /opt/defaults/config/config.sample.json \
    && cp -a /app/public/img/. /opt/defaults/public-img/ \
    && mkdir -p /app/logs /app/public/img \
    && chown -R app:app /opt/defaults /app/logs /app/public/img \
    && chown app:app /usr/local/bin/docker-entrypoint.sh \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/config", "/app/logs", "/app/public/img"]

USER app

EXPOSE 3000 3001 9000 9001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:3000/healthz',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1);});"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
