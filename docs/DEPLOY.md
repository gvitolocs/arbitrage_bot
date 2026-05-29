# Deployment

## Docker (recommended)

```bash
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f guardian
```

Restart: `docker compose restart guardian`  
Update: `git pull && docker compose up -d --build`  
Stop: `docker compose down`

## Oracle Cloud Ubuntu

```bash
sudo bash scripts/install-oracle-ubuntu.sh
sudo usermod -aG docker $USER   # re-login
git clone https://github.com/gvitolocs/arbitrage_bot.git /opt/wpkn-guardian
cd /opt/wpkn-guardian && cp .env.example .env
docker compose up -d --build
```

Free-tier Ampere (ARM64) is supported via multi-platform compose build.

## Systemd (no Docker)

```bash
npm ci && npm run build
sudo cp systemd/wpkn-guardian.service /etc/systemd/system/
# Edit WorkingDirectory=/opt/wpkn-guardian and User=
sudo systemctl enable --now wpkn-guardian
journalctl -u wpkn-guardian -f
```

## Telegram

1. [@BotFather](https://t.me/BotFather) → `/newbot` → token  
2. Message the bot → `https://api.telegram.org/bot<TOKEN>/getUpdates` → `chat.id`  
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `does not contain wPKN` | Wrong `WPKN_ADDRESS` or pool |
| RPC failures | Add fallbacks in `RPC_URLS` |
| High RAM | Raise `POLL_INTERVAL_SECONDS`; use compose memory limits |
