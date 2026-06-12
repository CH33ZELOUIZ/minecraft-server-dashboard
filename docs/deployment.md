# Deployment

This dashboard is designed for a Dockerized Minecraft server.

## Expected mounts

- Minecraft server data mounted read/write.
- Docker socket mounted only if you want container start/stop/restart controls.

## Core features

- server/container status
- logs
- RCON commands
- file browser/editor for trusted admins
- server icon upload
- settings helpers
- shell/terminal panel if enabled

## Recommended network placement

Run it on a trusted LAN/VPN or behind an auth proxy. A dashboard with Docker control should not be exposed as an unauthenticated public app.
