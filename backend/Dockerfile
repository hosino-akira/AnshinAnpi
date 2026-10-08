FROM node:22-bookworm-slim
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node backend/src ./src
COPY --chown=node:node backend/config ./config
COPY --chown=node:node backend/scripts ./scripts
RUN chown node:node /app
USER node
ENV API_HOST=0.0.0.0
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
