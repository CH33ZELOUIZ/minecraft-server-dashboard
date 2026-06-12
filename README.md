# Minecraft Server Dashboard

A lightweight self-hosted web dashboard for managing a Dockerized Minecraft server.
It wraps Docker, RCON, common Minecraft config files, logs, and a browser terminal into one mobile-friendly control panel.

## Features

- Live Docker container status: running/stopped/health, image, uptime, ports.
- Start, stop, and restart the configured Minecraft container.
- Run Minecraft/RCON commands from the browser.
- Tail server logs and browse/edit small files under the mounted server data directory.
- Edit common `server.properties` settings.
- Manage ops list where supported by the server image/RCON setup.
- Upload and resize `server-icon.png` to the required 64x64 PNG format.
- Optional browser shell into the Minecraft container via WebSocket + `docker exec`.
- Private-network-only API guard enabled by default.

## Security model

This dashboard can control Docker and edit Minecraft server files. Treat it as an admin tool, not a public website.

Recommended deployment:

- Run only on a trusted LAN or VPN.
- Keep `API_ALLOW_PRIVATE_ONLY=1` unless you add a real auth layer in front of it.
- Do not expose it directly to the public Internet.
- Understand that mounting `/var/run/docker.sock` gives this container high control over the host Docker daemon.

## Quick start

```bash
git clone https://github.com/<your-user>/minecraft-server-dashboard.git
cd minecraft-server-dashboard
cp .env.example .env
# edit .env: set MINECRAFT_CONTAINER and MINECRAFT_DATA_PATH
docker compose up -d --build
```

Open <http://localhost:3011> or `http://your-server-ip:3011` from your LAN/VPN.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_PORT` | `3011` | Host port exposed by Docker Compose. |
| `MINECRAFT_CONTAINER` | `minecraft-server` | Existing Docker container name for your Minecraft server. |
| `MINECRAFT_DATA_PATH` | `./minecraft-data` | Host path to the server data folder mounted as `/minecraft-data`. |
| `API_ALLOW_PRIVATE_ONLY` | `1` | Restrict API/WebSocket calls to private-network client IPs. |

The managed Minecraft container should include or support:

- `rcon-cli` for command execution and ops management.
- `mc-monitor` for richer live status, if available. The dashboard falls back to logs/properties when missing.
- Standard files such as `server.properties`, `ops.json`, and `logs/latest.log` in the mounted data directory.

## Development

```bash
npm install
npm run check
npm start
```

## License

MIT
