// /opt/ahvclaw/helper/src/cdp-manager.js
// CDP connection manager: Chrome detection, launch, and target management.
const CDP = require("chrome-remote-interface");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");

class CDPManager {
    constructor() {
        this.port = null;
        this.targets = new Map(); // targetId -> CDP client
    }

    async connect() {
        // Try to find Chrome with debug port already open
        this.port = await this.findDebugPort();

        if (!this.port) {
            // Chrome not running with debug port — try to launch
            const launched = await this.launchChrome();
            if (!launched) {
                throw new Error("Cannot connect to Chrome. Please restart Chrome from AHVclaw shortcut.");
            }
        }

        const version = await CDP.Version({ port: this.port });
        console.log(`[cdp] connected to Chrome ${version["Browser"]} on port ${this.port}`);
        return true;
    }

    async findDebugPort() {
        // Check state file first for previously used port
        const stateFile = this.getStateFilePath();
        if (fs.existsSync(stateFile)) {
            try {
                const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
                const version = await CDP.Version({ port: state.cdp_port });
                if (version) return state.cdp_port;
            } catch {}
        }

        // Scan known port range
        for (let port = 19200; port <= 19210; port++) {
            try {
                const version = await CDP.Version({ port });
                if (version) return port;
            } catch {}
        }
        return null;
    }

    async launchChrome() {
        const port = await this.findFreePort();
        const chromePath = this.findChromeBinary();
        const profilePath = this.findChromeProfile();

        if (!chromePath) {
            console.error("[cdp] Chrome binary not found");
            return false;
        }

        const args = [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profilePath}`,
        ];

        console.log(`[cdp] launching Chrome on port ${port}`);
        const chrome = spawn(chromePath, args, {
            detached: true,
            stdio: "ignore",
        });
        chrome.unref();

        // Wait for Chrome to start (up to 15s)
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                await CDP.Version({ port });
                this.port = port;
                this.saveState(port, chrome.pid);
                return true;
            } catch {}
        }
        return false;
    }

    async findFreePort() {
        return new Promise((resolve) => {
            const min = 19200, max = 19999;
            const port = min + Math.floor(Math.random() * (max - min));
            const server = net.createServer();
            server.listen(port, "127.0.0.1", () => {
                server.close(() => resolve(port));
            });
            server.on("error", () => {
                resolve(this.findFreePort());
            });
        });
    }

    findChromeBinary() {
        const platform = os.platform();
        const paths = {
            win32: [
                (process.env["PROGRAMFILES"] || "") + "\\Google\\Chrome\\Application\\chrome.exe",
                (process.env["PROGRAMFILES(X86)"] || "") + "\\Google\\Chrome\\Application\\chrome.exe",
                (process.env["LOCALAPPDATA"] || "") + "\\Google\\Chrome\\Application\\chrome.exe",
            ],
            darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
            linux: ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"],
        };
        for (const p of (paths[platform] || paths.linux)) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    findChromeProfile() {
        const platform = os.platform();
        const home = os.homedir();
        const profiles = {
            win32: path.join(process.env["LOCALAPPDATA"] || "", "Google", "Chrome", "User Data"),
            darwin: path.join(home, "Library", "Application Support", "Google", "Chrome"),
            linux: path.join(home, ".config", "google-chrome"),
        };
        return profiles[platform] || profiles.linux;
    }

    getStateFilePath() {
        const home = os.homedir();
        const dir = path.join(home, ".ahvclaw-helper");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
        return path.join(dir, "state.json");
    }

    saveState(port, pid) {
        const stateFile = this.getStateFilePath();
        fs.writeFileSync(stateFile, JSON.stringify({
            cdp_port: port,
            chrome_pid: pid,
            started_at: new Date().toISOString(),
        }), { mode: 0o600 });
    }

    async getTargets() {
        return CDP.List({ port: this.port });
    }

    async attachToTarget(targetId) {
        const client = await CDP({ port: this.port, target: targetId });
        await client.Page.enable();
        await client.Runtime.enable();
        await client.DOM.enable();
        this.targets.set(targetId, client);
        return client;
    }

    async detachTarget(targetId) {
        const client = this.targets.get(targetId);
        if (client) {
            try { await client.close(); } catch {}
            this.targets.delete(targetId);
        }
    }

    async detachAll() {
        for (const [, client] of this.targets) {
            try { await client.close(); } catch {}
        }
        this.targets.clear();
    }

    async close() {
        await this.detachAll();
    }
}

module.exports = CDPManager;
