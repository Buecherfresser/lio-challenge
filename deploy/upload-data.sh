#!/bin/sh
# Copies the local working database and snapshot archive to the server, once.
# Usage, from app/:  sh deploy/upload-data.sh [ssh host]   (default host: lio-georg)
# The container is stopped while the files are replaced. The server's .env is not touched.
set -eu
HOST=${1:-lio-georg}
APP=/opt/lineguard
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# A consistent copy of the running database (a plain file copy could miss what is still in the -wal file).
sqlite3 data/app.db ".backup $TMP/app.db"
echo "local database: $(sqlite3 "$TMP/app.db" 'select count(*) from documents where status = "done"') documents read, $(sqlite3 "$TMP/app.db" 'select count(*) from facts') facts"

ssh "$HOST" "cd $APP && docker compose stop && mkdir -p data/archive data/outbox && if [ -f data/app.db ]; then mkdir -p /root/lineguard-deploy-backups && tar czf /root/lineguard-deploy-backups/before-upload-\$(date +%Y%m%d-%H%M%S).tgz data/app.db*; fi"
rsync -a data/archive/ "$HOST:$APP/data/archive/"
scp -q "$TMP/app.db" "$HOST:$APP/data/app.db"
ssh "$HOST" "cd $APP && rm -f data/app.db-wal data/app.db-shm && chown -R 1000:1000 data && docker compose start && sleep 5 && docker compose logs --tail 5"
echo "uploaded to $HOST:$APP/data"
