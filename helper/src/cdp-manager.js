// /opt/ahvclaw/helper/src/cdp-manager.js
// CDP connection manager — spec A+ strategy:
//   1. State file (previous port) → try connect
//   2. Chrome running without debug → FAIL CLOSED, ask user to restart
//   3. Chrome not running → launch with random port, bind 127.0.0.1 only
//   NEVER self-restart a running Chrome. NEVER scan port ranges.
const CDP = require("chrome-remote-interface");
const { execSync, spawn } = require("child_process");
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
        // Step 1: Try state file (previous session port)
        const statePort = this.readStatePort();
        if (statePort) {
            try {
                const version = await CDP.Version({ port: statePort });
                if (version) {
                    this.port = statePort;
                    console.log(`[cdp] connected via state file to Chrome ${version["Browser"]} on port ${this.port}`);
                    return true;
                }
            } catch {}
        }

        // Step 2: Is Chrome running?
        const chromeRunning = this.isChromeRunning();

        if (chromeRunning) {
            // Chrome is running but we have no debug port — FAIL CLOSED.
            // Do NOT self-restart Chrome. Ask user to restart from AHVclaw shortcut.
            throw new Error(
                "Chrome dang chay nhung chua co debug port. " +
                "Can khoi dong lai Chrome tu shortcut AHVclaw de ket noi. " +
                "Cookie va tab hien tai se duoc giu nguyen."
            );
        }

        // Step 3: Chrome not running — launch with random port, bind 127.0.0.1
        const launched = await this.launchChrome();
        if (!launched) {
            throw new Error("Khong the khoi dong Chrome. Kiem tra Chrome da duoc cai dat.");
        }

        return true;
    }

    readStatePort() {
        const stateFile = this.getStateFilePath();
        if (!fs.existsSync(stateFile)) return null;
        try {
            const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            return state.cdp_port || null;
        } catch {
            return null;
        }
    }

    isChromeRunning() {
        const platform = os.platform();
        try {
            if (platform === "win32") {
                const result = execSync("tasklist /FI \"IMAGENAME eq chrome.exe\" /NH", { encoding: "utf8" });
                return result.includes("chrome.exe");
            } else if (platform === "darwin") {
                const result = execSync("pgrep -x 'Google Chrome' 2>/dev/null || true", { encoding: "utf8" });
                return result.trim().length > 0;
            } else {
                const result = execSync("pgrep -f '(chrome|chromium)' 2>/dev/null || true", { encoding: "utf8" });
                return result.trim().length > 0;
            }
        } catch {
            return false;
        }
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
            "--remote-debugging-address=127.0.0.1", // bind localhost only
            `--user-data-dir=${profilePath}`,
        ];

        console.log(`[cdp] launching Chrome on 127.0.0.1:${port}`);
        const chrome = spawn(chromePath, args, {
            detached: true,
            stdio: "ignore",
        });
        chrome.unref();

        // Wait for Chrome to start (up to 15s)
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const version = await CDP.Version({ port });
                this.port = port;
                this.saveState(port, chrome.pid);
                console.log(`[cdp] Chrome ${version["Browser"]} started on 127.0.0.1:${port}`);
                return true;
            } catch {}
        }
        console.error("[cdp] Chrome failed to start within 15s");
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
