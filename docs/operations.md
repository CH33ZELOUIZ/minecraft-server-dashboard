# Operations

## Health checks

- Dashboard HTTP page loads.
- Minecraft container state is visible.
- RCON command test works.
- Logs panel updates.
- File browser points to the intended server data directory.

## Troubleshooting

- If the dashboard cannot see the server, check Docker socket mount and container name.
- If files are missing, check the data mount path from inside the dashboard container.
- If RCON fails, verify Minecraft has RCON enabled and the dashboard has the right host/port/password.
