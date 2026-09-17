# Putting it on a server

One Linux server (Ubuntu 24.04 is assumed below), Postgres on the same
machine, the service under systemd, Caddy in front for https. Every command
here is run by you on the server. Nothing here asks for a password to be
shown to anyone, and no login ever leaves your screen.

## 1. System packages

```
sudo apt update
sudo apt install -y postgresql-16 caddy git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # must be 22.18 or later
```

## 2. The database

```
sudo -u postgres psql -c "CREATE USER telco WITH PASSWORD 'choose-a-long-password';"
sudo -u postgres psql -c "CREATE DATABASE telco OWNER telco;"
```

Keep that password for step 4. It goes in one file and nowhere else.

## 3. The code

```
sudo useradd --system --home /srv/telco --shell /usr/sbin/nologin telco
sudo git clone https://github.com/dingbapeter/telco.git /srv/telco
sudo chown -R telco:telco /srv/telco
cd /srv/telco
sudo -u telco npm ci --omit=dev --no-audit --no-fund
```

## 4. The environment file

```
sudo mkdir -p /etc/telco
sudo cp /srv/telco/deploy/telco.env.example /etc/telco/telco.env
sudo nano /etc/telco/telco.env    # fill in the database password and your domain
sudo chmod 600 /etc/telco/telco.env
sudo chown telco:telco /etc/telco/telco.env
```

## 5. The service and https

Edit `deploy/Caddyfile` to your domain first, then:

```
sudo cp /srv/telco/deploy/telco.service /etc/systemd/system/telco.service
sudo systemctl daemon-reload
sudo systemctl enable --now telco
sudo cp /srv/telco/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The service applies the database migrations every time it starts, so there
is no separate migration step, now or after any update.

Point your domain's DNS A record at the server before reloading Caddy;
Caddy fetches the certificate on the first request.

## 6. The first administrator

```
cd /srv/telco
sudo -u telco env $(sudo grep -v '^#' /etc/telco/telco.env | xargs) node scripts/create-admin.ts you@example.com "Your name"
```

The password is typed at the prompt and not shown. Then open
`https://your.domain/admin`, log in, and go to the launch checklist. It
tells you what is still red and where to set it.

## Checking it is really up

```
curl -s https://your.domain/health
```

should print `{"ok":true}`, which means the service answered and the
database answered it. If it does not:

```
sudo systemctl status telco
sudo journalctl -u telco -n 50
```

The log says in plain words what is wrong, for example that `DATABASE_URL`
is missing from the environment file.

## Updating

```
cd /srv/telco
sudo -u telco git pull
sudo -u telco npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart telco
```

Migrations run on start. Nothing else to do.

## Backups

```
sudo -u postgres pg_dump telco | gzip > /var/backups/telco-$(date +%F).sql.gz
```

Put that in a daily cron job and copy the files off the machine. The ledger
is the record of what everyone is owed; it is the one thing on the server
that cannot be rebuilt from the repository.
