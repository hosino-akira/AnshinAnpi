FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY anshin-anpi-admin-source/package*.json ./
RUN npm ci --no-audit --no-fund
COPY anshin-anpi-admin-source/vite.config.ts anshin-anpi-admin-source/next.config.ts anshin-anpi-admin-source/tsconfig.json anshin-anpi-admin-source/postcss.config.mjs ./
COPY anshin-anpi-admin-source/build ./build
COPY anshin-anpi-admin-source/.openai/hosting.json ./.openai/hosting.json
COPY anshin-anpi-admin-source/scripts/build-vps.mjs ./scripts/build-vps.mjs
COPY anshin-anpi-admin-source/components ./components
COPY anshin-anpi-admin-source/lib ./lib
COPY anshin-anpi-admin-source/hooks ./hooks
COPY anshin-anpi-admin-source/vendor ./vendor
COPY anshin-anpi-admin-source/app/layout.tsx anshin-anpi-admin-source/app/globals.css ./app/
COPY anshin-anpi-admin-source/app/admin ./app/admin
COPY anshin-anpi-admin-source/public ./public
RUN npm run build:vps

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/standalone/ ./
USER node
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/admin').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
