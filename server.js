'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const multer = require('multer');
const sharp = require('sharp');
const WebSocket = require('ws');
const pty = require('node-pty');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = Number(process.env.PORT || 3011);
const MINECRAFT_CONTAINER = process.env.MINECRAFT_CONTAINER || 'minecraft-server';
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || '/minecraft-data');
const API_ALLOW_PRIVATE_ONLY = !['0', 'false', 'no', 'off'].includes(String(process.env.API_ALLOW_PRIVATE_ONLY || '1').toLowerCase());
const upload = multer({ dest: '/tmp/minecraft-dashboard-uploads/', limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', 'xterm-addon-fit')));
app.use(express.static(path.join(__dirname, 'public')));

function isPrivateIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    const value = ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
    const min = ((100 * 256 + 64) * 256 + 0) * 256 + 0;
    const max = ((100 * 256 + 127) * 256 + 255) * 256 + 255;
    if (value >= min && value <= max) return true;
  }
  return false;
}

app.use('/api', (req, res, next) => {
  if (!API_ALLOW_PRIVATE_ONLY) return next();
  const ip = String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (isPrivateIp(ip)) return next();
  return res.status(403).json({ error: 'Private network only' });
});

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout || 15000, maxBuffer: 4 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function safeJoin(relativePath = '.') {
  const candidate = path.resolve(DATA_ROOT, '.' + path.sep + String(relativePath || '.'));
  const rootPrefix = DATA_ROOT.endsWith(path.sep) ? DATA_ROOT : DATA_ROOT + path.sep;
  if (candidate !== DATA_ROOT && !candidate.startsWith(rootPrefix)) {
    throw new Error('Path escapes data root');
  }
  return candidate;
}

function relFromRoot(fullPath) {
  const rel = path.relative(DATA_ROOT, fullPath);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

function envMapFromInspect(inspect) {
  const entries = Array.isArray(inspect?.Config?.Env) ? inspect.Config.Env : [];
  return Object.fromEntries(entries.map((entry) => {
    const idx = String(entry).indexOf('=');
    return idx === -1
      ? [String(entry), '']
      : [String(entry).slice(0, idx), String(entry).slice(idx + 1)];
  }));
}

function formatPortBindings(ports) {
  const bindings = [];
  for (const [containerPort, hostEntries] of Object.entries(ports || {})) {
    if (!Array.isArray(hostEntries)) continue;
    for (const entry of hostEntries) {
      bindings.push({
        containerPort,
        hostIp: entry.HostIp || '',
        hostPort: entry.HostPort || ''
      });
    }
  }
  return bindings;
}

async function containerInspect() {
  const { stdout } = await run('docker', ['inspect', MINECRAFT_CONTAINER], { timeout: 10000 });
  const parsed = JSON.parse(stdout);
  return parsed[0] || null;
}

async function dockerAction(action) {
  const allowed = new Set(['start', 'stop', 'restart']);
  if (!allowed.has(action)) throw new Error('Invalid action');
  await run('docker', [action, MINECRAFT_CONTAINER], { timeout: action === 'stop' ? 30000 : 20000 });
}

async function rconCommand(command) {
  return run('docker', ['exec', MINECRAFT_CONTAINER, 'sh', '-lc', `rcon-cli ${shellQuote(command)}`], { timeout: 15000 });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeDashboardCommand(command) {
  const trimmed = String(command || '').trim();
  const sayMatch = trimmed.match(/^say\s+([\s\S]+)$/i);
  if (sayMatch) {
    const message = sayMatch[1].trim();
    const payload = JSON.stringify([
      { text: '[Server OP] ', color: 'gold' },
      { text: message, color: 'white' }
    ]);
    return {
      actualCommand: `tellraw @a ${payload}`,
      displayOutput: `Broadcast sent as Server OP: ${message}`
    };
  }
  return {
    actualCommand: trimmed,
    displayOutput: ''
  };
}

async function readTail(filePath, lines = 200) {
  const content = await fsp.readFile(filePath, 'utf8');
  const parts = content.split(/\r?\n/);
  return parts.slice(Math.max(parts.length - lines, 0)).join('\n');
}

async function getLatestLogPath() {
  const logsDir = safeJoin('logs');
  return path.join(logsDir, 'latest.log');
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const sig = buffer.subarray(0, 8);
  if (!sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

async function readProperties() {
  const file = await fsp.readFile(safeJoin('server.properties'), 'utf8');
  const values = {};
  for (const line of file.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    values[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return values;
}

async function updateProperties(updates) {
  const fullPath = safeJoin('server.properties');
  const file = await fsp.readFile(fullPath, 'utf8');
  const lines = file.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates).map(([key, value]) => [key, String(value)]));
  const next = lines.map((line) => {
    if (!line || line.startsWith('#')) return line;
    const idx = line.indexOf('=');
    if (idx === -1) return line;
    const key = line.slice(0, idx);
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) next.push(`${key}=${value}`);
  await fsp.writeFile(fullPath, next.join('\n'), 'utf8');
}

async function readOps() {
  try {
    const raw = await fsp.readFile(safeJoin('ops.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeOps(entries) {
  await fsp.writeFile(safeJoin('ops.json'), JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

async function getSettings() {
  const props = await readProperties();
  const ops = await readOps();
  let iconExists = false;
  try {
    const stat = await fsp.stat(safeJoin('server-icon.png'));
    iconExists = stat.isFile();
  } catch (_) {}
  return {
    motd: props['motd'] || '',
    maxPlayers: props['max-players'] || '',
    difficulty: props['difficulty'] || 'easy',
    gamemode: props['gamemode'] || 'survival',
    whiteList: String(props['white-list'] || 'false') === 'true',
    pvp: String(props['pvp'] || 'true') === 'true',
    onlineMode: String(props['online-mode'] || 'true') === 'true',
    allowFlight: String(props['allow-flight'] || 'false') === 'true',
    spawnProtection: props['spawn-protection'] || '16',
    viewDistance: props['view-distance'] || '10',
    simulationDistance: props['simulation-distance'] || '10',
    ops,
    iconExists,
    iconUrl: iconExists ? '/api/server-icon' : null
  };
}

async function getStatus() {
  const inspect = await containerInspect();
  const state = inspect?.State || {};
  const env = envMapFromInspect(inspect);
  const mount = inspect?.Mounts?.find((item) => item.Destination === '/data');
  let playerText = '';
  let playersOnline = null;
  let maxPlayers = null;
  let version = '';
  let motd = '';
  let latestLog = '';
  let props = {};

  try {
    props = await readProperties();
    if (props['max-players']) maxPlayers = Number(props['max-players']);
    if (props['motd']) motd = props['motd'];
  } catch (_) {}

  if (state.Running) {
    try {
      const monitor = await run('docker', ['exec', MINECRAFT_CONTAINER, 'sh', '-lc', 'mc-monitor status --host 127.0.0.1 --port 25565 --json'], { timeout: 12000 });
      const parsed = JSON.parse(monitor.stdout || '{}');
      version = parsed.server_info?.version?.name || parsed.version?.name || parsed.version?.protocol || parsed.version?.id || '';
      const rawMotd = Array.isArray(parsed.server_info?.description?.extra)
        ? parsed.server_info.description.extra.map((part) => part?.text || '').join('')
        : (parsed.server_info?.description?.text || parsed.motd?.clean || parsed.motd?.raw || '');
      if (rawMotd) motd = Array.isArray(rawMotd) ? rawMotd.join(' ') : String(rawMotd);
      if (parsed.server_info?.players) {
        if (typeof parsed.server_info.players.online === 'number') playersOnline = parsed.server_info.players.online;
        if (typeof parsed.server_info.players.max === 'number' && parsed.server_info.players.max > 0) maxPlayers = parsed.server_info.players.max;
        playerText = `There are ${playersOnline} of a max of ${maxPlayers} players online`;
      } else if (parsed.players) {
        if (typeof parsed.players.online === 'number') playersOnline = parsed.players.online;
        if (typeof parsed.players.max === 'number' && parsed.players.max > 0) maxPlayers = parsed.players.max;
        playerText = `There are ${playersOnline} of a max of ${maxPlayers} players online`;
      }
    } catch (_) {}
  }

  try {
    latestLog = await readTail(await getLatestLogPath(), 120);
    if (!version) {
      const versionMatch = latestLog.match(/Starting minecraft server version\s+([^\n]+)/i) || latestLog.match(/Paper version\s+([^\n]+)/i);
      if (versionMatch) version = versionMatch[1].trim();
    }
  } catch (_) {}

  const healthLog = Array.isArray(state.Health?.Log) ? state.Health.Log : [];
  const lastHealthEntry = healthLog.length ? healthLog[healthLog.length - 1] : null;
  const lastHealthOutput = String(lastHealthEntry?.Output || '').trim();
  const pauseLogLines = latestLog.split(/\r?\n/).filter((line) => /Server empty .* pausing/i.test(line));
  const lastPauseLogLine = pauseLogLines.length ? pauseLogLines[pauseLogLines.length - 1] : '';
  const autopauseEnabled = ['1', 'true', 'yes', 'on'].includes(String(env.ENABLE_AUTOPAUSE || '').toLowerCase());
  const autopauseState = !autopauseEnabled
    ? 'disabled'
    : !state.Running
      ? 'container-stopped'
      : playersOnline > 0
        ? 'players-online'
        : lastPauseLogLine
          ? 'sleep-mode-active'
          : 'armed';

  return {
    serverName: MINECRAFT_CONTAINER,
    running: !!state.Running,
    status: state.Status || 'unknown',
    health: state.Health?.Status || null,
    startedAt: state.StartedAt || null,
    finishedAt: state.FinishedAt || null,
    image: inspect?.Config?.Image || '',
    mountSource: mount?.Source || DATA_ROOT,
    version,
    motd,
    playersOnline,
    maxPlayers,
    playerText,
    ports: inspect?.NetworkSettings?.Ports || {},
    portBindings: formatPortBindings(inspect?.NetworkSettings?.Ports || {}),
    latestLog,
    autopause: {
      enabled: autopauseEnabled,
      state: autopauseState,
      timeouts: {
        init: env.AUTOPAUSE_TIMEOUT_INIT || null,
        knock: env.AUTOPAUSE_TIMEOUT_KN || null,
        empty: env.AUTOPAUSE_TIMEOUT_EST || null
      },
      lastPauseLogLine: lastPauseLogLine || null,
      lastHealthOutput: lastHealthOutput || null,
      hardStopDisablesWake: true
    }
  };
}

app.get('/api/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message, stderr: error.stderr || '' });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const requested = req.query.file ? String(req.query.file) : 'logs/latest.log';
    const lines = Math.min(Math.max(Number(req.query.lines || 200), 20), 2000);
    const fullPath = safeJoin(requested);
    const text = await readTail(fullPath, lines);
    res.json({ file: relFromRoot(fullPath), text });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/files', async (req, res) => {
  try {
    const fullPath = safeJoin(req.query.path ? String(req.query.path) : '.');
    const stat = await fsp.stat(fullPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
    const entries = await fsp.readdir(fullPath, { withFileTypes: true });
    const items = await Promise.all(entries
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(async (entry) => {
        const child = path.join(fullPath, entry.name);
        const childStat = await fsp.stat(child);
        return {
          name: entry.name,
          path: relFromRoot(child),
          type: entry.isDirectory() ? 'dir' : 'file',
          size: childStat.size,
          modifiedAt: childStat.mtime.toISOString()
        };
      }));
    res.json({ current: relFromRoot(fullPath), parent: relFromRoot(path.resolve(fullPath, '..')) === '..' ? null : relFromRoot(path.resolve(fullPath, '..')), items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/file', async (req, res) => {
  try {
    const fullPath = safeJoin(String(req.query.path || ''));
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    const maxBytes = 512 * 1024;
    if (stat.size > maxBytes) return res.status(400).json({ error: 'File too large to edit in browser', size: stat.size });
    const content = await fsp.readFile(fullPath, 'utf8');
    res.json({ path: relFromRoot(fullPath), content, size: stat.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/file/save', async (req, res) => {
  try {
    const relativePath = String(req.body.path || '');
    const content = String(req.body.content || '');
    const fullPath = safeJoin(relativePath);
    await fsp.writeFile(fullPath, content, 'utf8');
    res.json({ ok: true, path: relFromRoot(fullPath) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/file/delete', async (req, res) => {
  try {
    const fullPath = safeJoin(String(req.body.path || ''));
    await fsp.rm(fullPath, { recursive: true, force: false });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/file/rename', async (req, res) => {
  try {
    const from = safeJoin(String(req.body.from || ''));
    const to = safeJoin(String(req.body.to || ''));
    await fsp.rename(from, to);
    res.json({ ok: true, path: relFromRoot(to) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/file/mkdir', async (req, res) => {
  try {
    const fullPath = safeJoin(String(req.body.path || ''));
    await fsp.mkdir(fullPath, { recursive: true });
    res.json({ ok: true, path: relFromRoot(fullPath) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/file/upload', upload.single('file'), async (req, res) => {
  try {
    const targetDir = safeJoin(String(req.body.path || '.'));
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Missing upload' });
    const dest = path.join(targetDir, file.originalname);
    await fsp.rename(file.path, dest);
    res.json({ ok: true, path: relFromRoot(dest) });
  } catch (error) {
    if (req.file?.path) await fsp.rm(req.file.path, { force: true }).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/file/download', async (req, res) => {
  try {
    const fullPath = safeJoin(String(req.query.path || ''));
    res.download(fullPath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {
      'motd': String(body.motd || '').trim(),
      'max-players': String(body.maxPlayers || '').trim(),
      'difficulty': String(body.difficulty || 'easy').trim(),
      'gamemode': String(body.gamemode || 'survival').trim(),
      'white-list': body.whiteList ? 'true' : 'false',
      'pvp': body.pvp === false ? 'false' : 'true',
      'online-mode': body.onlineMode === false ? 'false' : 'true',
      'allow-flight': body.allowFlight ? 'true' : 'false',
      'spawn-protection': String(body.spawnProtection || '16').trim(),
      'view-distance': String(body.viewDistance || '10').trim(),
      'simulation-distance': String(body.simulationDistance || '10').trim()
    };
    if (!updates['motd']) return res.status(400).json({ error: 'MOTD is required' });
    if (!/^\d+$/.test(updates['max-players'])) return res.status(400).json({ error: 'Max players must be a number' });
    await updateProperties(updates);
    res.json({ ok: true, settings: await getSettings() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings/icon', upload.single('icon'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing icon upload' });
    const dest = safeJoin('server-icon.png');
    const input = await fsp.readFile(req.file.path);
    const before = pngDimensions(input);
    const output = await sharp(input)
      .resize(64, 64, { fit: 'fill' })
      .png()
      .toBuffer();
    const after = pngDimensions(output);
    if (!after || after.width !== 64 || after.height !== 64) {
      throw new Error('Failed to produce a valid 64x64 PNG icon');
    }
    await fsp.writeFile(dest, output);
    await fsp.rm(req.file.path, { force: true });
    res.json({ ok: true, iconUrl: '/api/server-icon', sourceSize: before, finalSize: after });
  } catch (error) {
    if (req.file?.path) await fsp.rm(req.file.path, { force: true }).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/server-icon', async (req, res) => {
  try {
    res.sendFile(safeJoin('server-icon.png'));
  } catch (error) {
    res.status(404).json({ error: 'Server icon not found' });
  }
});

app.post('/api/settings/op', async (req, res) => {
  try {
    const action = String(req.body.action || '').trim();
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Missing player name' });
    if (action === 'add') {
      const inspect = await containerInspect();
      if (!inspect?.State?.Running) return res.status(400).json({ error: 'Server must be running to grant op' });
      await rconCommand(`op ${name}`);
      return res.json({ ok: true, ops: await readOps() });
    }
    if (action === 'remove') {
      try {
        const inspect = await containerInspect();
        if (inspect?.State?.Running) await rconCommand(`deop ${name}`);
      } catch (_) {}
      const existing = await readOps();
      const filtered = existing.filter((entry) => String(entry.name || '').toLowerCase() !== name.toLowerCase());
      await writeOps(filtered);
      return res.json({ ok: true, ops: filtered });
    }
    return res.status(400).json({ error: 'Invalid op action' });
  } catch (error) {
    res.status(500).json({ error: error.message, stderr: (error.stderr || '').trim(), stdout: (error.stdout || '').trim() });
  }
});

app.post('/api/action', async (req, res) => {
  try {
    const action = String(req.body.action || '');
    await dockerAction(action);
    res.json({ ok: true, action });
  } catch (error) {
    res.status(500).json({ error: error.message, stderr: error.stderr || '' });
  }
});

app.post('/api/command', async (req, res) => {
  try {
    const command = String(req.body.command || '').trim();
    if (!command) return res.status(400).json({ error: 'Missing command' });
    const normalized = normalizeDashboardCommand(command);
    const result = await rconCommand(normalized.actualCommand);
    const output = (result.stdout || result.stderr || '').trim() || normalized.displayOutput || `Command sent: ${command}`;
    res.json({ ok: true, output, executed: normalized.actualCommand });
  } catch (error) {
    res.status(500).json({ error: error.message, stderr: (error.stderr || '').trim(), stdout: (error.stdout || '').trim() });
  }
});

app.get('/api/terminal/info', (req, res) => {
  res.json({ container: MINECRAFT_CONTAINER, mode: 'docker-exec-shell' });
});

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws/terminal') {
    socket.destroy();
    return;
  }
  if (API_ALLOW_PRIVATE_ONLY) {
    const ip = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!isPrivateIp(ip)) {
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  const term = pty.spawn('docker', ['exec', '-it', MINECRAFT_CONTAINER, 'sh'], {
    name: 'xterm-color',
    cols: 120,
    rows: 32,
    cwd: '/',
    env: process.env
  });

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });

  term.onExit(({ exitCode, signal }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'input') term.write(String(message.data || ''));
      if (message.type === 'resize') term.resize(Number(message.cols || 120), Number(message.rows || 32));
    } catch (_) {}
  });

  ws.on('close', () => {
    try { term.kill(); } catch (_) {}
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Minecraft dashboard listening on ${PORT}`);
});
