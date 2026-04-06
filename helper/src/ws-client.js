// /opt/ahvclaw/helper/src/ws-client.js
// WebSocket client to AHVclaw server with session management and auto-renew.
const WebSocket = require("ws");

class WSClient {
    constructor(serverUrl, options = {}) {
        this.serverUrl = serverUrl;
        this.token = options.token;
        this.sessionId = null;
        this.onCommand = options.onCommand || (() => {});
        this.onKill = options.onKill || (() => {});
        this.onConnected = options.onConnected || (() => {});
        this.onSessionEstablished = options.onSessionEstablished || (() => {});
        this.ws = null;
        this.reconnectDelay = 3000;
        this.maxReconnectDelay = 30000;
        this.disconnectTimer = null;
        this.renewTimer = null;
        this.alive = true;
    }

    connect() {
        const url = `${this.serverUrl}?token=${this.token}`;
        this.ws = new WebSocket(url);

        this.ws.on("open", () => {
            console.log("[ws] connected to server");
            this.reconnectDelay = 3000;
            this.clearDisconnectTimer();
            this.onConnected();
        });

        this.ws.on("message", (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }

            if (msg.type === "hello_accepted") {
                this.sessionId = msg.session_id;
                this.onSessionEstablished(this.sessionId);
                console.log(`[ws] session established: ${this.sessionId}, expires: ${msg.expires_at}`);
                this.scheduleRenew(msg.expires_at);
                return;
            }
            if (msg.type === "hello_rejected") {
                console.error(`[ws] hello rejected: ${msg.error}`);
                return;
            }
            if (msg.type === "renew_accepted") {
                this.sessionId = msg.session_id;
                this.onSessionEstablished(this.sessionId);
                console.log(`[ws] session renewed, expires: ${msg.expires_at}`);
                this.scheduleRenew(msg.expires_at);
                return;
            }
            if (msg.type === "renew_rejected") {
                console.error(`[ws] renew rejected: ${msg.error}`);
                this.alive = false;
                return;
            }

            // Command from server (has action field)
            if (msg.action) {
                this.onCommand(msg);
                return;
            }
        });

        this.ws.on("close", () => {
            console.log("[ws] disconnected");
            this.startDisconnectTimer();
            if (this.alive) {
                setTimeout(() => this.connect(), this.reconnectDelay);
                this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
            }
        });

        this.ws.on("error", (err) => {
            console.error("[ws] error:", err.message);
        });
    }

    sendHello(helloPayload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(helloPayload));
        }
    }

    sendResult(result) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(result));
        }
    }

    scheduleRenew(expiresAt) {
        if (this.renewTimer) clearTimeout(this.renewTimer);
        const expiresMs = new Date(expiresAt).getTime();
        const renewIn = expiresMs - Date.now() - (5 * 60 * 1000); // 5 min before expiry
        if (renewIn > 0) {
            this.renewTimer = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: "session_renew",
                        session_id: this.sessionId,
                    }));
                }
            }, renewIn);
        }
    }

    startDisconnectTimer() {
        if (this.disconnectTimer) return;
        this.disconnectTimer = setTimeout(() => {
            console.log("[ws] disconnected > 60s, shutting down");
            this.alive = false;
            this.onKill();
        }, 60000);
    }

    clearDisconnectTimer() {
        if (this.disconnectTimer) {
            clearTimeout(this.disconnectTimer);
            this.disconnectTimer = null;
        }
    }

    close() {
        this.alive = false;
        if (this.renewTimer) clearTimeout(this.renewTimer);
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        if (this.ws) this.ws.close();
    }
}

module.exports = WSClient;
