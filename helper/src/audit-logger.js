// /opt/ahvclaw/helper/src/audit-logger.js
// Local file log + send to server.
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

class AuditLogger {
    constructor(token) {
        this.token = token;
        this.logDir = path.join(os.homedir(), ".ahvclaw-helper", "logs");
        if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
        this.logFile = path.join(this.logDir, `audit-${new Date().toISOString().split("T")[0]}.jsonl`);
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
        const url = new URL("https://api.ahvclaw.com/api/companion/audit");

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: url.hostname,
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
