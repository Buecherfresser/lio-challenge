#!/bin/sh
# Forced command of the GitHub deploy key (authorized_keys: command="/opt/lineguard/deploy/deploy.sh",restrict ...).
# Reads a tar of the app code on stdin (see .github/workflows/deploy.yml), backs up the database, replaces the code
# and rebuilds the container. data/ and .env are never touched.
set -eu
APP=/opt/lineguard
BK=/root/lineguard-deploy-backups
cd "$APP"
mkdir -p "$BK" data && chown 1000:1000 data
if ls data/app.db >/dev/null 2>&1; then
  tar czf "$BK/db-$(date +%Y%m%d-%H%M%S).tgz" data/app.db*
  ls -1t "$BK"/db-*.tgz | tail -n +21 | xargs -r rm --        # keep the last 20 automatic backups
fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar -x -C "$tmp"
[ -f "$tmp/server/main.ts" ] && [ -f "$tmp/web/package.json" ] || { echo "incomplete upload" >&2; exit 1; }
for f in package.json package-lock.json tsconfig.json Dockerfile compose.yml .dockerignore; do
  [ -e "$tmp/$f" ] && cp "$tmp/$f" "$APP/$f"
done
for d in server shared prompts web .claude; do
  [ -d "$tmp/$d" ] || continue
  rm -rf "$APP/$d.new" && cp -r "$tmp/$d" "$APP/$d.new" && rm -rf "$APP/$d" && mv "$APP/$d.new" "$APP/$d"
done
mkdir -p "$APP/deploy" && cp "$tmp/deploy/deploy.sh" "$APP/deploy/deploy.sh.next"   # takes effect after review: mv by hand
docker compose up -d --build 2>&1 | tail -n 5
echo "deployed $(date -Is)"
