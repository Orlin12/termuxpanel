// TermuxPanel v2.2 — Modern Minecraft Server Management Panel
// Designed for Termux on Android

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const archiver = require('archiver');
const tar = require('tar');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

// ─── Paths ───────────────────────────────────────────────────────────────────
const ROOT_DIR = __dirname;
const MC_DIR = path.join(ROOT_DIR, 'minecraft');
const BACKUP_DIR = path.join(ROOT_DIR, 'backups');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const UPLOAD_DIR = path.join(ROOT_DIR, '.uploads_tmp');

// Ensure directories exist
[MC_DIR, BACKUP_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ─── Configuration ───────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    serverName: 'My Minecraft Server',
    port: 8080,
    javaPath: 'java',
    minMemory: '1024M',
    maxMemory: '2048M',
    jvmFlags: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200',
    selectedJar: 'server.jar',
    maxBackups: 10,
    autoStart: false,
    maxConsoleLines: 1000,
    passwordHash: null,
    jwtSecret: null,
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return { ...DEFAULT_CONFIG, ...saved };
        }
    } catch (e) { console.error('Failed to load config:', e.message); }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
if (!config.jwtSecret) {
    config.jwtSecret = uuidv4() + uuidv4();
    saveConfig(config);
}

// ─── Express + Socket.IO setup ───────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Multer for file uploads
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10GB max

// ─── Minecraft Process Management ────────────────────────────────────────────
let mcProcess = null;
let consoleBuffer = [];
let serverStartTime = null;
let serverStatus = 'stopped'; // stopped, starting, running, stopping

function addConsoleLine(line, type = 'info') {
    const entry = { time: new Date().toISOString(), text: line, type };
    consoleBuffer.push(entry);
    if (consoleBuffer.length > config.maxConsoleLines) {
        consoleBuffer = consoleBuffer.slice(-config.maxConsoleLines);
    }
    io.emit('console:line', entry);
}

function detectLogLevel(line) {
    if (/\bERROR\b/i.test(line) || /\bSEVERE\b/i.test(line) || /\bFATAL\b/i.test(line)) return 'error';
    if (/\bWARN\b/i.test(line) || /\bWARNING\b/i.test(line)) return 'warn';
    if (/\bDEBUG\b/i.test(line)) return 'debug';
    return 'info';
}

function startMinecraftServer() {
    if (mcProcess) return { success: false, message: 'Server is already running.' };

    const jarPath = path.join(MC_DIR, config.selectedJar);
    if (!fs.existsSync(jarPath)) {
        return { success: false, message: `JAR file not found: ${config.selectedJar}` };
    }

    serverStatus = 'starting';
    io.emit('server:status', serverStatus);
    addConsoleLine(`Starting server with ${config.selectedJar}...`, 'info');

    const jvmArgs = config.jvmFlags.split(/\s+/).filter(Boolean);
    const args = [
        `-Xms${config.minMemory}`,
        `-Xmx${config.maxMemory}`,
        ...jvmArgs,
        '-jar', config.selectedJar,
        'nogui'
    ];

    mcProcess = spawn(config.javaPath, args, {
        cwd: MC_DIR,
        env: { ...process.env, TERM: 'xterm' }
    });

    serverStartTime = Date.now();

    mcProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => {
            const level = detectLogLevel(line);
            addConsoleLine(line, level);
            // Detect when server is fully started
            if (/Done \(\d+.*?\)! For help, type "help"/i.test(line)) {
                serverStatus = 'running';
                io.emit('server:status', serverStatus);
            }
        });
    });

    mcProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => addConsoleLine(line, 'error'));
    });

    mcProcess.on('close', (code) => {
        addConsoleLine(`Server process exited with code ${code}`, code === 0 ? 'info' : 'error');
        mcProcess = null;
        serverStartTime = null;
        serverStatus = 'stopped';
        io.emit('server:status', serverStatus);
    });

    mcProcess.on('error', (err) => {
        addConsoleLine(`Failed to start server: ${err.message}`, 'error');
        mcProcess = null;
        serverStartTime = null;
        serverStatus = 'stopped';
        io.emit('server:status', serverStatus);
    });

    return { success: true, message: 'Server starting...' };
}

function stopMinecraftServer(force = false) {
    if (!mcProcess) return { success: false, message: 'Server is not running.' };

    serverStatus = 'stopping';
    io.emit('server:status', serverStatus);

    if (force) {
        addConsoleLine('Force killing server...', 'warn');
        mcProcess.kill('SIGKILL');
    } else {
        addConsoleLine('Sending stop command...', 'info');
        mcProcess.stdin.write('stop\n');
        // Force kill after 30 seconds if still running
        setTimeout(() => {
            if (mcProcess) {
                addConsoleLine('Server did not stop gracefully, force killing...', 'warn');
                mcProcess.kill('SIGKILL');
            }
        }, 30000);
    }

    return { success: true, message: force ? 'Server force killed.' : 'Server stopping...' };
}

function restartMinecraftServer() {
    if (mcProcess) {
        addConsoleLine('Restarting server...', 'info');
        serverStatus = 'stopping';
        io.emit('server:status', serverStatus);
        mcProcess.stdin.write('stop\n');

        const waitForStop = setInterval(() => {
            if (!mcProcess) {
                clearInterval(waitForStop);
                setTimeout(() => startMinecraftServer(), 1000);
            }
        }, 500);

        setTimeout(() => {
            clearInterval(waitForStop);
            if (mcProcess) {
                mcProcess.kill('SIGKILL');
                setTimeout(() => startMinecraftServer(), 1000);
            }
        }, 30000);

        return { success: true, message: 'Server restarting...' };
    } else {
        return startMinecraftServer();
    }
}

function sendCommand(cmd) {
    if (!mcProcess) return { success: false, message: 'Server is not running.' };
    mcProcess.stdin.write(cmd + '\n');
    addConsoleLine(`> ${cmd}`, 'command');
    return { success: true, message: `Command sent: ${cmd}` };
}

// ─── Authentication Middleware ───────────────────────────────────────────────
function authMiddleware(req, res, next) {
    // If no password set, allow everything (first-time setup)
    if (!config.passwordHash) return next();

    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        req.user = jwt.verify(token, config.jwtSecret);
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
    res.json({ needsSetup: !config.passwordHash });
});

app.post('/api/auth/setup', async (req, res) => {
    if (config.passwordHash) return res.status(400).json({ error: 'Password already set' });
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    config.passwordHash = await bcrypt.hash(password, 10);
    saveConfig(config);

    const token = jwt.sign({ role: 'admin' }, config.jwtSecret, { expiresIn: '7d' });
    res.json({ success: true, token });
});

app.post('/api/auth/login', async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });

    if (!config.passwordHash) return res.status(400).json({ error: 'No password set, please run setup' });

    const valid = await bcrypt.compare(password, config.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign({ role: 'admin' }, config.jwtSecret, { expiresIn: '7d' });
    res.json({ success: true, token });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });

    if (config.passwordHash) {
        const valid = await bcrypt.compare(currentPassword, config.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    config.passwordHash = await bcrypt.hash(newPassword, 10);
    saveConfig(config);
    res.json({ success: true });
});

// ─── Apply auth to all /api routes except auth ──────────────────────────────
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    authMiddleware(req, res, next);
});

// ─── Server Control Routes ───────────────────────────────────────────────────
app.get('/api/server/status', (req, res) => {
    res.json({
        status: serverStatus,
        uptime: serverStartTime ? Math.floor((Date.now() - serverStartTime) / 1000) : 0,
        jar: config.selectedJar,
        serverName: config.serverName
    });
});

app.post('/api/server/start', (req, res) => {
    res.json(startMinecraftServer());
});

app.post('/api/server/stop', (req, res) => {
    res.json(stopMinecraftServer(false));
});

app.post('/api/server/restart', (req, res) => {
    res.json(restartMinecraftServer());
});

app.post('/api/server/kill', (req, res) => {
    res.json(stopMinecraftServer(true));
});

app.post('/api/server/command', (req, res) => {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Command required' });
    res.json(sendCommand(command));
});

app.get('/api/server/console', (req, res) => {
    res.json(consoleBuffer);
});

// ─── Resource Monitoring ─────────────────────────────────────────────────────
function getSystemStats() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // CPU usage calculation
    let cpuUsage = 0;
    try {
        const cpuTimes = cpus.reduce((acc, cpu) => {
            acc.user += cpu.times.user;
            acc.nice += cpu.times.nice;
            acc.sys += cpu.times.sys;
            acc.idle += cpu.times.idle;
            acc.irq += cpu.times.irq;
            return acc;
        }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });

        const total = Object.values(cpuTimes).reduce((a, b) => a + b, 0);
        cpuUsage = total > 0 ? Math.round(((total - cpuTimes.idle) / total) * 100) : 0;
    } catch (e) { /* ignore */ }

    // Disk usage
    let diskTotal = 0, diskUsed = 0, diskFree = 0;
    try {
        const dfOutput = execSync('df -k "' + MC_DIR + '" 2>/dev/null | tail -1', { encoding: 'utf8' });
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 4) {
            diskTotal = parseInt(parts[1]) * 1024;
            diskUsed = parseInt(parts[2]) * 1024;
            diskFree = parseInt(parts[3]) * 1024;
        }
    } catch (e) { /* ignore */ }

    // MC dir size
    let mcDirSize = 0;
    try {
        const duOutput = execSync('du -sk "' + MC_DIR + '" 2>/dev/null', { encoding: 'utf8' });
        mcDirSize = parseInt(duOutput.split(/\s/)[0]) * 1024;
    } catch (e) { /* ignore */ }

    return {
        cpu: {
            usage: cpuUsage,
            cores: cpus.length,
            model: cpus[0]?.model || 'Unknown'
        },
        memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            percent: Math.round((usedMem / totalMem) * 100)
        },
        disk: {
            total: diskTotal,
            used: diskUsed,
            free: diskFree,
            percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0
        },
        mcDirSize,
        uptime: os.uptime(),
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname()
    };
}

// Store previous CPU measurements for accurate usage calculation
let prevCpuTimes = null;
function getCpuUsage() {
    const cpus = os.cpus();
    const current = cpus.reduce((acc, cpu) => {
        acc.user += cpu.times.user;
        acc.nice += cpu.times.nice;
        acc.sys += cpu.times.sys;
        acc.idle += cpu.times.idle;
        acc.irq += cpu.times.irq;
        return acc;
    }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });

    if (!prevCpuTimes) {
        prevCpuTimes = current;
        return 0;
    }

    const diff = {};
    for (const key of Object.keys(current)) {
        diff[key] = current[key] - prevCpuTimes[key];
    }
    prevCpuTimes = current;

    const total = Object.values(diff).reduce((a, b) => a + b, 0);
    return total > 0 ? Math.round(((total - diff.idle) / total) * 100) : 0;
}

app.get('/api/stats', (req, res) => {
    const stats = getSystemStats();
    stats.cpu.usage = getCpuUsage();
    res.json(stats);
});

// ─── JAR Management ──────────────────────────────────────────────────────────
app.get('/api/jars', (req, res) => {
    try {
        const files = fs.readdirSync(MC_DIR)
            .filter(f => f.endsWith('.jar'))
            .map(f => {
                const stat = fs.statSync(path.join(MC_DIR, f));
                return {
                    name: f,
                    size: stat.size,
                    modified: stat.mtime,
                    selected: f === config.selectedJar
                };
            });
        res.json(files);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/jars/select', (req, res) => {
    const { jar } = req.body;
    if (!jar) return res.status(400).json({ error: 'JAR name required' });
    const jarPath = path.join(MC_DIR, jar);
    if (!fs.existsSync(jarPath)) return res.status(404).json({ error: 'JAR not found' });

    config.selectedJar = jar;
    saveConfig(config);
    res.json({ success: true, selectedJar: jar });
});

app.post('/api/jars/upload', upload.single('jar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const originalName = req.file.originalname;
    if (!originalName.endsWith('.jar')) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Only .jar files allowed' });
    }

    const destPath = path.join(MC_DIR, originalName);
    fs.renameSync(req.file.path, destPath);
    res.json({ success: true, name: originalName });
});

app.delete('/api/jars/:name', (req, res) => {
    const jarName = req.params.name;
    if (!jarName.endsWith('.jar')) return res.status(400).json({ error: 'Invalid file' });

    const jarPath = path.join(MC_DIR, jarName);
    if (!fs.existsSync(jarPath)) return res.status(404).json({ error: 'JAR not found' });

    if (config.selectedJar === jarName) {
        return res.status(400).json({ error: 'Cannot delete the currently selected JAR' });
    }

    fs.unlinkSync(jarPath);
    res.json({ success: true });
});

// Download popular server JARs
app.post('/api/jars/download', async (req, res) => {
    const { type, version } = req.body;
    if (!type) return res.status(400).json({ error: 'Server type required' });

    let downloadUrl = '';
    let fileName = '';

    try {
        if (type === 'paper') {
            // Paper API
            const ver = version || '1.21.4';
            const buildsRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${ver}/builds`);
            if (!buildsRes.ok) throw new Error('Failed to fetch Paper builds');
            const buildsData = await buildsRes.json();
            const latestBuild = buildsData.builds[buildsData.builds.length - 1];
            const buildNum = latestBuild.build;
            const download = latestBuild.downloads.application.name;
            downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${buildNum}/downloads/${download}`;
            fileName = `paper-${ver}-${buildNum}.jar`;
        } else if (type === 'purpur') {
            const ver = version || '1.21.4';
            downloadUrl = `https://api.purpurmc.org/v2/purpur/${ver}/latest/download`;
            fileName = `purpur-${ver}.jar`;
        } else if (type === 'vanilla') {
            const ver = version || '1.21.4';
            // Mojang version manifest
            const manifestRes = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
            const manifest = await manifestRes.json();
            const versionInfo = manifest.versions.find(v => v.id === ver);
            if (!versionInfo) throw new Error(`Version ${ver} not found`);
            const versionRes = await fetch(versionInfo.url);
            const versionData = await versionRes.json();
            downloadUrl = versionData.downloads.server.url;
            fileName = `vanilla-${ver}.jar`;
        } else if (type === 'fabric') {
            const ver = version || '1.21.4';
            // Fabric installer
            const installerRes = await fetch('https://meta.fabricmc.net/v2/versions/installer');
            const installers = await installerRes.json();
            const latestInstaller = installers[0].version;
            const loaderRes = await fetch('https://meta.fabricmc.net/v2/versions/loader');
            const loaders = await loaderRes.json();
            const latestLoader = loaders[0].version;
            downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${ver}/${latestLoader}/${latestInstaller}/server/jar`;
            fileName = `fabric-${ver}.jar`;
        } else {
            return res.status(400).json({ error: 'Unknown server type. Supported: paper, purpur, vanilla, fabric' });
        }

        addConsoleLine(`Downloading ${fileName}...`, 'info');
        io.emit('jar:downloading', { name: fileName });

        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        const destPath = path.join(MC_DIR, fileName);
        fs.writeFileSync(destPath, buffer);

        addConsoleLine(`Downloaded ${fileName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`, 'info');
        io.emit('jar:downloaded', { name: fileName, size: buffer.length });

        res.json({ success: true, name: fileName, size: buffer.length });
    } catch (e) {
        addConsoleLine(`Download failed: ${e.message}`, 'error');
        res.status(500).json({ error: e.message });
    }
});

// Get available versions for a server type
app.get('/api/jars/versions/:type', async (req, res) => {
    const { type } = req.params;
    try {
        let versions = [];
        if (type === 'paper') {
            const r = await fetch('https://api.papermc.io/v2/projects/paper');
            const d = await r.json();
            versions = d.versions.reverse();
        } else if (type === 'purpur') {
            const r = await fetch('https://api.purpurmc.org/v2/purpur');
            const d = await r.json();
            versions = d.versions.reverse();
        } else if (type === 'vanilla') {
            const r = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
            const d = await r.json();
            versions = d.versions.filter(v => v.type === 'release').map(v => v.id);
        } else if (type === 'fabric') {
            const r = await fetch('https://meta.fabricmc.net/v2/versions/game');
            const d = await r.json();
            versions = d.filter(v => v.stable).map(v => v.version);
        }
        res.json(versions);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── File Manager ────────────────────────────────────────────────────────────
function safePath(userPath) {
    const resolved = path.resolve(MC_DIR, userPath || '');
    if (!resolved.startsWith(MC_DIR)) return null;
    return resolved;
}

app.get('/api/files', (req, res) => {
    const dirPath = safePath(req.query.path || '');
    if (!dirPath) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Directory not found' });

    try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

        const items = fs.readdirSync(dirPath).map(name => {
            try {
                const itemPath = path.join(dirPath, name);
                const itemStat = fs.statSync(itemPath);
                return {
                    name,
                    isDirectory: itemStat.isDirectory(),
                    size: itemStat.size,
                    modified: itemStat.mtime,
                    permissions: (itemStat.mode & 0o777).toString(8)
                };
            } catch (e) {
                return { name, isDirectory: false, size: 0, modified: null, error: true };
            }
        });

        // Sort: directories first, then alphabetical
        items.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        const relativePath = path.relative(MC_DIR, dirPath) || '.';
        res.json({ path: relativePath, items });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/files/read', (req, res) => {
    const filePath = safePath(req.query.path);
    if (!filePath) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot read a directory' });
    if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large to read (>5MB)' });

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        res.json({ content, size: stat.size, path: path.relative(MC_DIR, filePath) });
    } catch (e) {
        res.status(500).json({ error: 'Cannot read binary file' });
    }
});

app.put('/api/files/write', (req, res) => {
    const filePath = safePath(req.body.path);
    if (!filePath) return res.status(403).json({ error: 'Access denied' });

    try {
        fs.writeFileSync(filePath, req.body.content);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/upload', upload.array('files', 20), (req, res) => {
    const destDir = safePath(req.body.path || '');
    if (!destDir) return res.status(403).json({ error: 'Access denied' });

    const results = [];
    for (const file of req.files) {
        const dest = path.join(destDir, file.originalname);
        fs.renameSync(file.path, dest);
        results.push({ name: file.originalname, size: file.size });
    }
    res.json({ success: true, files: results });
});

app.get('/api/files/download', (req, res) => {
    const filePath = safePath(req.query.path);
    if (!filePath) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    res.download(filePath);
});

app.post('/api/files/mkdir', (req, res) => {
    const dirPath = safePath(req.body.path);
    if (!dirPath) return res.status(403).json({ error: 'Access denied' });

    try {
        fs.mkdirSync(dirPath, { recursive: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/rename', (req, res) => {
    const oldPath = safePath(req.body.oldPath);
    const newPath = safePath(req.body.newPath);
    if (!oldPath || !newPath) return res.status(403).json({ error: 'Access denied' });

    try {
        fs.renameSync(oldPath, newPath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/files/delete', (req, res) => {
    const filePath = safePath(req.body.path);
    if (!filePath) return res.status(403).json({ error: 'Access denied' });
    if (filePath === MC_DIR) return res.status(403).json({ error: 'Cannot delete root directory' });

    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true });
        } else {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/files/delete-all', (req, res) => {
    if (mcProcess) return res.status(400).json({ error: 'Stop the server before deleting all files.' });

    try {
        const items = fs.readdirSync(MC_DIR);
        let deleted = 0;
        for (const item of items) {
            const itemPath = path.join(MC_DIR, item);
            fs.rmSync(itemPath, { recursive: true, force: true });
            deleted++;
        }
        addConsoleLine(`[Panel] Deleted all server files (${deleted} items)`, 'warn');
        res.json({ success: true, deleted });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Server Properties ──────────────────────────────────────────────────────
const PROPERTIES_PATH = path.join(MC_DIR, 'server.properties');

const PROPERTY_DESCRIPTIONS = {
    'server-port': 'Port the server runs on',
    'gamemode': 'Default game mode (survival, creative, adventure, spectator)',
    'difficulty': 'Server difficulty (peaceful, easy, normal, hard)',
    'max-players': 'Maximum number of players',
    'motd': 'Message shown in server list',
    'level-name': 'Name of the world folder',
    'level-seed': 'World generation seed',
    'pvp': 'Enable PvP combat',
    'spawn-protection': 'Radius of spawn protection',
    'view-distance': 'View distance in chunks',
    'simulation-distance': 'Simulation distance in chunks',
    'online-mode': 'Enable Mojang authentication',
    'white-list': 'Enable whitelist',
    'spawn-monsters': 'Enable monster spawning',
    'spawn-animals': 'Enable animal spawning',
    'spawn-npcs': 'Enable NPC spawning',
    'allow-flight': 'Allow flying',
    'allow-nether': 'Enable the Nether',
    'generate-structures': 'Generate structures (villages, etc.)',
    'max-world-size': 'Maximum world radius',
    'enable-command-block': 'Enable command blocks',
    'hardcore': 'Enable hardcore mode',
    'server-ip': 'Bind to specific IP (leave blank for all)',
    'resource-pack': 'URL to resource pack',
    'enable-query': 'Enable GameSpy4 protocol server listener',
    'enable-rcon': 'Enable remote console',
    'rcon.password': 'RCON password',
    'rcon.port': 'RCON port',
    'level-type': 'World type (normal, flat, etc.)',
};

function parseProperties(content) {
    const props = {};
    content.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx === -1) return;
        const key = line.substring(0, idx).trim();
        const value = line.substring(idx + 1).trim();
        props[key] = value;
    });
    return props;
}

function stringifyProperties(props) {
    const header = '#Minecraft server properties\n#Generated by TermuxPanel\n';
    const lines = Object.entries(props).map(([k, v]) => `${k}=${v}`);
    return header + lines.join('\n') + '\n';
}

app.get('/api/properties', (req, res) => {
    if (!fs.existsSync(PROPERTIES_PATH)) {
        return res.json({ exists: false, properties: {}, descriptions: PROPERTY_DESCRIPTIONS });
    }
    try {
        const content = fs.readFileSync(PROPERTIES_PATH, 'utf8');
        const props = parseProperties(content);
        res.json({ exists: true, properties: props, descriptions: PROPERTY_DESCRIPTIONS });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/properties', (req, res) => {
    const { properties } = req.body;
    if (!properties) return res.status(400).json({ error: 'Properties required' });

    try {
        fs.writeFileSync(PROPERTIES_PATH, stringifyProperties(properties));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Backup System ───────────────────────────────────────────────────────────
app.get('/api/backups', (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.tar.gz'))
            .map(f => {
                const stat = fs.statSync(path.join(BACKUP_DIR, f));
                return { name: f, size: stat.size, created: stat.mtime };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backups/create', async (req, res) => {
    const name = req.body.name || `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const backupPath = path.join(BACKUP_DIR, `${name}.tar.gz`);

    try {
        addConsoleLine(`Creating backup: ${name}...`, 'info');
        io.emit('backup:creating', { name });

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(backupPath);
            const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });

            output.on('close', resolve);
            archive.on('error', reject);

            archive.pipe(output);
            archive.directory(MC_DIR, 'minecraft');
            archive.finalize();
        });

        const stat = fs.statSync(backupPath);
        addConsoleLine(`Backup created: ${name} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`, 'info');
        io.emit('backup:created', { name, size: stat.size });

        // Auto-delete oldest if over limit
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.tar.gz'))
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
            .sort((a, b) => a.time - b.time);

        while (backups.length > config.maxBackups) {
            const oldest = backups.shift();
            fs.unlinkSync(path.join(BACKUP_DIR, oldest.name));
            addConsoleLine(`Auto-deleted old backup: ${oldest.name}`, 'info');
        }

        res.json({ success: true, name: `${name}.tar.gz`, size: stat.size });
    } catch (e) {
        addConsoleLine(`Backup failed: ${e.message}`, 'error');
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/backups/restore/:name', async (req, res) => {
    const backupPath = path.join(BACKUP_DIR, req.params.name);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });

    if (mcProcess) return res.status(400).json({ error: 'Stop the server before restoring a backup' });

    const tempDir = path.join(ROOT_DIR, '.restore_tmp_' + Date.now());

    try {
        addConsoleLine(`Restoring backup: ${req.params.name}...`, 'warn');

        // Extract to temp directory first to detect structure
        fs.mkdirSync(tempDir, { recursive: true });
        await tar.x({ file: backupPath, cwd: tempDir });

        // Detect structure: check if extracted content has a 'minecraft' subdirectory
        const extractedItems = fs.readdirSync(tempDir);
        let sourceDir = tempDir;

        if (extractedItems.length === 1 && fs.statSync(path.join(tempDir, extractedItems[0])).isDirectory()) {
            // Single top-level directory (e.g. 'minecraft/' or any folder name) — use its contents
            sourceDir = path.join(tempDir, extractedItems[0]);
        }

        // Clear minecraft directory
        const mcItems = fs.readdirSync(MC_DIR);
        for (const item of mcItems) {
            fs.rmSync(path.join(MC_DIR, item), { recursive: true, force: true });
        }

        // Move extracted files into minecraft directory
        const filesToCopy = fs.readdirSync(sourceDir);
        for (const item of filesToCopy) {
            fs.renameSync(path.join(sourceDir, item), path.join(MC_DIR, item));
        }

        // Cleanup temp dir
        fs.rmSync(tempDir, { recursive: true, force: true });

        addConsoleLine(`Backup restored: ${req.params.name} (${filesToCopy.length} items)`, 'info');
        res.json({ success: true });
    } catch (e) {
        // Cleanup temp dir on failure
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        addConsoleLine(`Restore failed: ${e.message}`, 'error');
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/backups/:name', (req, res) => {
    const backupPath = path.join(BACKUP_DIR, req.params.name);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });

    try {
        fs.unlinkSync(backupPath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/backups/download/:name', (req, res) => {
    const backupPath = path.join(BACKUP_DIR, req.params.name);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });
    res.download(backupPath);
});

app.post('/api/backups/upload', upload.single('backup'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const originalName = req.file.originalname;
    if (!originalName.endsWith('.tar.gz')) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Only .tar.gz files are allowed' });
    }

    const destPath = path.join(BACKUP_DIR, originalName);
    fs.renameSync(req.file.path, destPath);

    const stat = fs.statSync(destPath);
    addConsoleLine(`[Panel] Uploaded backup: ${originalName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`, 'info');
    res.json({ success: true, name: originalName, size: stat.size });
});

// ─── Task Scheduler ──────────────────────────────────────────────────────────
const SCHEDULES_PATH = path.join(ROOT_DIR, 'schedules.json');
let schedules = [];
let scheduleTasks = {};

function loadSchedules() {
    try {
        if (fs.existsSync(SCHEDULES_PATH)) {
            schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
        }
    } catch (e) { schedules = []; }
}

function saveSchedules() {
    fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
}

function activateSchedule(schedule) {
    if (scheduleTasks[schedule.id]) {
        scheduleTasks[schedule.id].stop();
        delete scheduleTasks[schedule.id];
    }

    if (!schedule.enabled) return;

    try {
        const task = cron.schedule(schedule.cron, () => {
            addConsoleLine(`[Scheduler] Running task: ${schedule.name}`, 'info');
            switch (schedule.action) {
                case 'start': startMinecraftServer(); break;
                case 'stop': stopMinecraftServer(); break;
                case 'restart': restartMinecraftServer(); break;
                case 'command': sendCommand(schedule.payload || ''); break;
                case 'backup':
                    const backupName = `scheduled-${new Date().toISOString().replace(/[:.]/g, '-')}`;
                    // Trigger backup via internal function
                    const backupPath = path.join(BACKUP_DIR, `${backupName}.tar.gz`);
                    const output = fs.createWriteStream(backupPath);
                    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });
                    output.on('close', () => addConsoleLine(`[Scheduler] Backup created: ${backupName}`, 'info'));
                    archive.on('error', (e) => addConsoleLine(`[Scheduler] Backup failed: ${e.message}`, 'error'));
                    archive.pipe(output);
                    archive.directory(MC_DIR, 'minecraft');
                    archive.finalize();
                    break;
            }
        });
        scheduleTasks[schedule.id] = task;
    } catch (e) {
        addConsoleLine(`[Scheduler] Invalid cron for ${schedule.name}: ${e.message}`, 'error');
    }
}

loadSchedules();
schedules.forEach(s => activateSchedule(s));

app.get('/api/schedules', (req, res) => {
    res.json(schedules);
});

app.post('/api/schedules', (req, res) => {
    const { name, cron: cronExpression, action, payload, enabled } = req.body;
    if (!name || !cronExpression || !action) {
        return res.status(400).json({ error: 'Name, cron, and action are required' });
    }
    if (!cron.validate(cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression' });
    }

    const schedule = {
        id: uuidv4(),
        name,
        cron: cronExpression,
        action,
        payload: payload || '',
        enabled: enabled !== false,
        created: new Date().toISOString()
    };

    schedules.push(schedule);
    saveSchedules();
    activateSchedule(schedule);

    res.json(schedule);
});

app.put('/api/schedules/:id', (req, res) => {
    const idx = schedules.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

    const { name, cron: cronExpression, action, payload, enabled } = req.body;
    if (cronExpression && !cron.validate(cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression' });
    }

    schedules[idx] = {
        ...schedules[idx],
        ...(name !== undefined && { name }),
        ...(cronExpression !== undefined && { cron: cronExpression }),
        ...(action !== undefined && { action }),
        ...(payload !== undefined && { payload }),
        ...(enabled !== undefined && { enabled })
    };

    saveSchedules();
    activateSchedule(schedules[idx]);
    res.json(schedules[idx]);
});

app.delete('/api/schedules/:id', (req, res) => {
    const idx = schedules.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

    if (scheduleTasks[req.params.id]) {
        scheduleTasks[req.params.id].stop();
        delete scheduleTasks[req.params.id];
    }

    schedules.splice(idx, 1);
    saveSchedules();
    res.json({ success: true });
});

// ─── Panel Configuration ────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
    // Don't send sensitive fields
    const { passwordHash, jwtSecret, ...safeConfig } = config;
    res.json(safeConfig);
});

app.put('/api/config', (req, res) => {
    const allowed = ['serverName', 'javaPath', 'minMemory', 'maxMemory', 'jvmFlags', 'selectedJar', 'maxBackups', 'autoStart', 'maxConsoleLines', 'port'];
    const updates = {};

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            updates[key] = req.body[key];
        }
    }

    config = { ...config, ...updates };
    saveConfig(config);

    const { passwordHash, jwtSecret, ...safeConfig } = config;
    res.json(safeConfig);
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    // Send current state on connect
    socket.emit('server:status', serverStatus);
    socket.emit('console:history', consoleBuffer);

    // Handle commands from console
    socket.on('console:command', (cmd) => {
        if (typeof cmd === 'string' && cmd.trim()) {
            sendCommand(cmd.trim());
        }
    });
});

// Broadcast stats every 2 seconds
setInterval(() => {
    const stats = getSystemStats();
    stats.cpu.usage = getCpuUsage();
    stats.serverStatus = serverStatus;
    stats.serverUptime = serverStartTime ? Math.floor((Date.now() - serverStartTime) / 1000) : 0;
    io.emit('stats:update', stats);
}, 2000);

// ─── Fallback — serve SPA ───────────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = config.port || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔════════════════════════════════════════╗`);
    console.log(`  ║     TermuxPanel v2.2                   ║`);
    console.log(`  ║     Minecraft Server Management        ║`);
    console.log(`  ╠════════════════════════════════════════╣`);
    console.log(`  ║  Panel:  http://localhost:${PORT}          ║`);
    console.log(`  ║  Status: Running                       ║`);
    console.log(`  ╚════════════════════════════════════════╝\n`);

    if (config.autoStart) {
        console.log('  Auto-starting Minecraft server...');
        startMinecraftServer();
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down TermuxPanel...');
    if (mcProcess) {
        mcProcess.stdin.write('stop\n');
        setTimeout(() => {
            if (mcProcess) mcProcess.kill('SIGKILL');
            process.exit(0);
        }, 10000);
    } else {
        process.exit(0);
    }
});
