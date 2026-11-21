# Auto-Deploy auf den VPS

Nach einem Push auf `main` läuft erst die CI (Typecheck und Dashboard-Build), danach schickt GitHub den App-Code per SSH an Georgs VPS (178.104.40.53). Dort baut Docker den Container neu, und Caddy liefert ihn unter https://procurement.jonasdrechsel.com aus. Der DNS-Eintrag zeigt schon per CNAME auf `hanzi.georgchrist.de`.

Der SSH-Schlüssel darf auf dem Server **nur** `deploy/deploy.sh` ausführen (Forced Command). Das Skript sichert zuerst die Datenbank, ersetzt dann den Code und baut den Container neu. `data/` und `.env` auf dem Server bleiben unangetastet.

## Einmalig einrichten

Die Schritte 1 bis 4 braucht Root-Zugang zum VPS, also macht sie Georg (oder jemand mit seinem Schlüssel).

```sh
# 1. Ordner, .env und Startdaten auf dem Server
ssh vps 'mkdir -p /opt/lineguard/deploy /opt/lineguard/data && chown 1000:1000 /opt/lineguard/data'
scp .env vps:/opt/lineguard/.env        # vorher APP_PASSWORD eintragen, siehe unten
# optional: den lokalen Stand mitnehmen, damit der Server nicht bei null anfängt
rsync -a data/ vps:/opt/lineguard/data/ && ssh vps 'chown -R 1000:1000 /opt/lineguard/data'

# 2. Schlüssel nur für das Deployment
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy lineguard" -f /tmp/lineguard-deploy

# 3. Skript auf den Server, Schlüssel mit Forced Command eintragen
ssh vps 'cp /root/.ssh/authorized_keys /root/.ssh/authorized_keys.bak'
scp deploy/deploy.sh vps:/opt/lineguard/deploy/deploy.sh
ssh vps "chmod 755 /opt/lineguard/deploy/deploy.sh && echo 'command=\"/opt/lineguard/deploy/deploy.sh\",restrict $(cat /tmp/lineguard-deploy.pub)' >> /root/.ssh/authorized_keys"

# 4. Caddy: neue Seite eintragen und neu laden
ssh vps 'cat >> /opt/core/Caddyfile' <<'EOF'

procurement.jonasdrechsel.com {
	reverse_proxy 127.0.0.1:8101
}
EOF
ssh vps 'cd /opt/core && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile'

# 5. Secrets ins Repository, dann den privaten Schlüssel löschen
gh secret set DEPLOY_SSH_KEY -R Buecherfresser/lio-challenge < /tmp/lineguard-deploy
ssh-keyscan -t ed25519,ecdsa,rsa 178.104.40.53 2>/dev/null | gh secret set DEPLOY_KNOWN_HOSTS -R Buecherfresser/lio-challenge
rm /tmp/lineguard-deploy /tmp/lineguard-deploy.pub
```

Pfad und Reload-Befehl in Schritt 4 hängen davon ab, wie Caddy in `/opt/core` eingerichtet ist. Ein Blick in die `compose.yml` dort zeigt beides. Vorher mit `ssh vps 'ss -ltn | grep 8101'` prüfen, dass Port 8101 frei ist. Sonst den Port in `compose.yml` und im Caddyfile gemeinsam ändern.

## Die .env auf dem Server

Der Container liest alle Einstellungen aus `/opt/lineguard/.env`, wie lokal aus `app/.env`. Zwei Dinge kommen für den Server dazu:

- `APP_PASSWORD=...` schützt Dashboard und API mit einem Login (Benutzer `soony`, änderbar mit `APP_USER`). Ohne Passwort kann jeder mit dem Link Mails freigeben und OpenAI-Guthaben verbrauchen.
- `LIO_TOKEN=...` muss drinstehen, weil der Server die Datei `lio-key.env` nicht hat.

`DATA_DIR` und `PORT` setzt `compose.yml`, die Werte aus der `.env` gelten dafür nicht.

## Testen

GitHub → Actions → „Deploy“ → „Run workflow“ startet ein Deployment von Hand. Danach muss https://procurement.jonasdrechsel.com nach dem Passwort fragen, und `ssh vps ls /root/lineguard-deploy-backups` zeigt eine neue Sicherung, sobald es eine Datenbank gibt.

## Hinweise

- Neue Versionen von `deploy.sh` landen auf dem Server nur als `deploy/deploy.sh.next`. Übernehmen erst nach Durchsicht: `ssh vps 'cd /opt/lineguard/deploy && diff deploy.sh deploy.sh.next; mv deploy.sh.next deploy.sh'`.
- Zurücknehmen: die Zeile mit `github-actions-deploy lineguard` aus `/root/.ssh/authorized_keys` löschen.
- Logs: `ssh vps 'cd /opt/lineguard && docker compose logs -f --tail 100'`.
