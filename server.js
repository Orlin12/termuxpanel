const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let minecraftProcess = null;

// Function to start the Minecraft server
function startMinecraftServer() {
    minecraftProcess = spawn('java', ['-Xmx3024M', '-Xms1024M', '-jar', 'server.jar', 'nogui'], {
        cwd: path.join(__dirname, 'minecraft')
    });

    minecraftProcess.stdout.on('data', (data) => {
        console.log(`Minecraft: ${data}`);
    });

    minecraftProcess.stderr.on('data', (data) => {
        console.error(`Minecraft Error: ${data}`);
    });

    minecraftProcess.on('close', (code) => {
        console.log(`Minecraft process exited with code ${code}`);
    });
}

// Function to stop the Minecraft server
function stopMinecraftServer() {
    if (minecraftProcess) {
        minecraftProcess.kill('SIGINT');
        minecraftProcess = null;
        console.log('Minecraft server stopped.');
    }
}

// Set up the web server
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Minecraft Web Panel</title>
                <script>
                    const ws = new WebSocket('ws://' + location.host);

                    ws.onmessage = (event) => {
                        const log = document.getElementById('log');
                        const { type, message } = JSON.parse(event.data);

                        if (type === 'log') {
                            log.textContent = message;
                        } else if (type === 'status') {
                            alert(message);
                        }
                    };

                    function sendCommand() {
                        const input = document.getElementById('commandInput');
                        const command = input.value;
                        if (command) {
                            ws.send(JSON.stringify({ command }));
                            input.value = '';
                        }
                    }

                    function startServer() {
                        ws.send(JSON.stringify({ command: 'start' }));
                    }

                    function stopServer() {
                        ws.send(JSON.stringify({ command: 'stop' }));
                    }
                </script>
            </head>
            <body>
                <h1>Minecraft Web Panel</h1>
                <pre id="log" style="background: #000; color: #0f0; padding: 10px; height: 400px; overflow-y: scroll;">Loading...</pre>
                <input type="text" id="commandInput" placeholder="Enter a command">
                <button onclick="sendCommand()">Send</button>
                <br>
                <button onclick="startServer()">Start Server</button>
                <button onclick="stopServer()">Stop Server</button>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Set up WebSocket server
const wss = new WebSocket.Server({ server });

// Watch the latest.log file and broadcast updates
const logFilePath = path.join(__dirname, 'minecraft', 'logs', 'latest.log');
let latestLogContent = '';

function broadcastLogUpdates() {
    fs.readFile(logFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading log file:', err);
            return;
        }

        if (data !== latestLogContent) {
            latestLogContent = data;
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'log', message: latestLogContent }));
                }
            });
        }
    });
}

// Update the log every 2 seconds
setInterval(broadcastLogUpdates, 2000);

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('A client connected');

    ws.on('message', (message) => {
        const { command } = JSON.parse(message);
        if (command === 'start') {
            if (!minecraftProcess) {
                startMinecraftServer();
                ws.send(JSON.stringify({ type: 'status', message: 'Minecraft server started.' }));
            } else {
                ws.send(JSON.stringify({ type: 'status', message: 'Minecraft server is already running.' }));
            }
        } else if (command === 'stop') {
            if (minecraftProcess) {
                stopMinecraftServer();
                ws.send(JSON.stringify({ type: 'status', message: 'Minecraft server stopped.' }));
            } else {
                ws.send(JSON.stringify({ type: 'status', message: 'Minecraft server is not running.' }));
            }
        } else if (command) {
            if (minecraftProcess) {
                minecraftProcess.stdin.write(`${command}\n`);
                ws.send(JSON.stringify({ type: 'status', message: `Command sent: ${command}` }));
            } else {
                ws.send(JSON.stringify({ type: 'status', message: 'Minecraft server is not running. Please start the server first.' }));
            }
        }
    });

    ws.on('close', () => {
        console.log('A client disconnected');
    });
});

// Start the web server
server.listen(8080, () => {
    console.log('Minecraft web panel running at http://localhost:8080');
});

