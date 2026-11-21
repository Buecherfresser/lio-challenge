# Stage 1 builds the dashboard (web/dist). Stage 2 runs the backend, which serves the dashboard on the same port.
FROM node:26-slim AS web
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY shared ./shared
COPY web ./web
RUN npm --prefix web run build

FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY prompts ./prompts
COPY .claude/skills ./.claude/skills
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TZ=Europe/Berlin
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/main.ts"]
