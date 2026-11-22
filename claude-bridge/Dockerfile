# Claude Code in a box, behind an OpenAI-style endpoint (bridge.mjs). For testing and development only:
# the agents then run on the Claude account this container is logged in with instead of on OpenAI credit.
# Log in once:  docker compose exec -it claude claude   (then /login). The login lives in ./claude-home on the host.
FROM node:26-slim
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /app
COPY bridge.mjs ./
USER node
ENV HOME=/home/node PORT=8790
EXPOSE 8790
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8790/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/bridge.mjs"]
