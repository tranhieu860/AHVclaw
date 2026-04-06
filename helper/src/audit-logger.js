// /opt/ahvclaw/helper/src/audit-logger.js
// Local file log + send to server. Server URL derived from WSS URL.
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

class AuditLogger {
    constructor(serverWsUrl, token) {
        this.token = token;
        this.logDir = path.join(os.homedir(), ".ahvclaw-helper", "logs");
        if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
        this.logFile = path.join(this.logDir, `audit-${new Date().toISOString().split("T")[0]}.jsonl`);

        // Derive REST API URL from WebSocket URL
        // wss://api.ahvclaw.com/ws/computer-use -> https://api.ahvclaw.com/api/companion/audit
        // ws://localhost:3000/ws/computer-use -> http://localhost:3000/api/companion/audit
        this.auditUrl = this.deriveAuditUrl(serverWsUrl);
    }

    deriveAuditUrl(wsUrl) {
        try {
            const url = new URL(wsUrl);
            url.protocol = url.protocol === "wss:" ? "https:" : "http:";
            url.pathname = "/api/companion/audit";
            // Remove query params (token etc)
            url.search = "";
            return url.toString();
        } catch {
            return "https://api.ahvclaw.com/api/companion/audit";
        }
    }

    log(cmd, result, durationMs = 0) {
        const entry = {
            timestamp: new Date().toISOString(),
            action: cmd.action,
            url: cmd.params?.url || null,
            tab_id: cmd.params?.tabId || null,
            result: result.status,
            blocked_reason: result.blocked_reason || null,
            duration_ms: durationMs,
        };

        // Redact sensitive params
        const safeParams = { ...cmd.params };
        delete safeParams.text;
        entry.params = safeParams;

        // Write to local file
        try {
            fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
        } catch (err) {
            console.error("[audit] local log error:", err.message);
        }

        // Send to server (fire and forget)
        this.sendToServer(entry).catch(() => {});
    }

    async sendToServer(entry) {
        const body = JSON.stringify(entry);
        const url = new URL(this.auditUrl);
        const transport = url.protocol === "https:" ? https : http;

        return new Promise((resolve, reject) => {
            const req = transport.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.token}`,
                    "Content-Length": Buffer.byteLength(body),
                },
            }, (res) => {
                res.resume();
                resolve();
            });
            req.on("error", reject);
            req.write(body);
            req.end();
        });
    }
}

module.exports = AuditLogger;
