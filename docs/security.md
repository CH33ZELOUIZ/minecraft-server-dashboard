# Security notes

This dashboard can be powerful. Treat it like an admin tool.

## Docker socket risk

Mounting `/var/run/docker.sock` gives the container access to Docker control. That can be equivalent to host-level control depending on what actions are exposed.

Safer options:

- keep the app private-network-only
- put it behind strong auth
- expose fixed actions instead of arbitrary shell commands
- use a restricted Docker socket proxy for production-style setups

## RCON

RCON credentials should live in `.env` or a secret manager, not in source code.
