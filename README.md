# TermuxPanel v2.0

**Modern Minecraft Server Management Panel for Termux**

A sleek, feature-rich web panel for managing your Minecraft server directly from your Android device via Termux. Inspired by Pterodactyl Panel and Crafty Controller.

---

## ✨ Features

- **🖥️ Dashboard** — Server status, resource gauges (CPU/RAM/Disk), quick actions, system info
- **💻 Console** — Real-time server log viewer with color-coded output and command input (with history)
- **📁 File Manager** — Browse, edit, upload, download, and delete server files from your browser
- **☕ JAR Manager** — Upload custom JARs or download Paper, Purpur, Vanilla, or Fabric with version picker
- **⚙️ Server Config** — Visual editor for `server.properties` with grouped categories and descriptions
- **💾 Backups** — Create, restore, download, and auto-manage server backups
- **⏰ Scheduler** — Cron-based task automation (restart, backup, commands, etc.)
- **🔐 Authentication** — Password-protected access with JWT tokens
- **📱 Mobile Responsive** — Designed for phone-first use in Termux
- **🌙 Modern UI** — Dark theme with glassmorphism, smooth animations, and Inter font

---

## 🚀 Setup

### Prerequisites
- **Termux** (or any Linux environment)
- **Node.js** (v18+)
- **Java** (OpenJDK 17+ for modern Minecraft servers)

### Installation

```bash
# Clone the repository
git clone https://github.com/Orlin12/termuxpanel.git
cd termuxpanel

# Install dependencies
npm install

# Start the panel
node server.js
```

### Access
Open your browser and go to:
```
http://localhost:8080
```
Or from another device on the same network:
```
http://<your-phone-ip>:8080
```

### First Time Setup
1. Open the panel in your browser
2. Create an admin password
3. Place your Minecraft server `.jar` in the `minecraft/` directory (or use the JAR Manager to download one)
4. Click **Start** on the dashboard

---

## 📂 Project Structure

```
termuxpanel/
├── server.js          # Backend (Express + Socket.IO)
├── package.json       # Dependencies
├── config.json        # Auto-generated panel config
├── public/
│   ├── index.html     # SPA shell
│   ├── css/style.css  # Design system
│   └── js/app.js      # Frontend application
├── minecraft/         # Your server files go here
├── backups/           # Backup storage
└── README.md
```

---

## ⚙️ Configuration

Settings can be changed from the **Settings** page in the panel, or by editing `config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `serverName` | My Minecraft Server | Display name |
| `port` | 8080 | Panel web port |
| `javaPath` | java | Path to Java binary |
| `minMemory` | 1024M | JVM min heap (-Xms) |
| `maxMemory` | 2048M | JVM max heap (-Xmx) |
| `jvmFlags` | G1GC flags | Additional JVM arguments |
| `maxBackups` | 10 | Auto-delete oldest when exceeded |
| `autoStart` | false | Start MC server with panel |

---

## 📝 License

ISC
