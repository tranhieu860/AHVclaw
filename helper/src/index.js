// /opt/ahvclaw/helper/src/index.js
// AHVclaw Browser Companion Native Helper — entry point with lifecycle.
// FAIL-CLOSED: helper does NOT go online (no WS hello) unless CDP is connected.
const WSClient = require("./ws-client");
const CDPManager = require("./cdp-manager");
const TabManager = require("./tab-manager");
const CommandExecutor = require("./command-executor");
const Security = require("./security");
const AuditLogger = require("./audit-logger");
const Keypair = require("./keypair");
const NativeMessaging = require("./native-messaging");
const crypto = require("crypto");

const SERVER_URL = process.env.AHVCLAW_SERVER || "wss://api.ahvclaw.com/ws/computer-use";
const TOKEN = process.env.AHVCLAW_TOKEN;

if (!TOKEN) {
    console.error("AHVCLAW_TOKEN environment variable required");
    process.exit(1);
}

// Extract user_id from JWT payload (base64-decoded, no secret needed).
function extractUserIdFromJWT(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        return payload.sub || payload.user_id || null;
    } catch {
        return null;
    }
}

const USER_ID = process.env.AHVCLAW_USER_ID || extractUserIdFromJWT(TOKEN);
if (!USER_ID) {
    console.error("Cannot determine user_id. Set AHVCLAW_USER_ID or use a valid JWT token.");
    process.exit(1);
}

async function main() {
    const cdp = new CDPManager();
    const tabManager = new TabManager(cdp);
    const security = new Security();
    const audit = new AuditLogger(SERVER_URL, TOKEN);
    const keypair = await Keypair.loadOrGenerate();
    const executor = new CommandExecutor(cdp, tabManager, security, audit, {
        sessionId: null, // set after hello_accepted
        userId: USER_ID,
    });

    let killing = false;
    let cdpReady = false;

    // Audit helper for critical events (sends to server + local JSONL)
    function auditCritical(action, result, extra = {}) {
        audit.log(
            { action, params: extra },
            { status: result, blocked_reason: extra.blocked_reason || null },
        );
    }

    async function killSwitch() {
        if (killing) return;
        killing = true;
        auditCritical("kill_switch", "triggered", { source: "helper" });
        console.log("[kill] step 1: stop accepting commands");
        executor.accepting = false;

        console.log("[kill] step 2: clear pending queue");
        executor.clearPending("session_killed");

        console.log("[kill] step 3: detach CDP");
        await cdp.detachAll();

        console.log("[kill] step 4: close helper-created tabs");
        await tabManager.closeHelperTabs();

        console.log("[kill] step 5: exit");
        if (ws) ws.close();
        process.exit(0);
    }

    function killWithTimeout() {
        killSwitch();
        setTimeout(() => {
            console.log("[kill] force exit after 5s timeout");
            process.exit(1);
        }, 5000);
    }

    let ws = null;

    function createWSClient() {
        return new WSClient(SERVER_URL, {
            token: TOKEN,
            onCommand: (cmd) => executor.execute(cmd, ws),
            onKill: () => {
                auditCritical("helper_disconnect", "kill_received");
                killWithTimeout();
            },
            onConnected: () => {
                const nonce = crypto.randomBytes(16).toString("hex");
                const payloadObj = {
                    user_id: USER_ID,
                    device_id: keypair.deviceId,
                    helper_version: "1.0.0",
                    timestamp: new Date().toISOString(),
                    nonce: nonce,
                };
                const payloadStr = JSON.stringify(payloadObj);
                const signature = keypair.sign(payloadStr);

                ws.sendHello({
                    type: "helper_hello",
                    user_id: USER_ID,
                    device_id: keypair.deviceId,
                    helper_version: "1.0.0",
                    signature: signature,
                    signed_payload: Buffer.from(payloadStr).toString("base64"),
                });
            },
            onSessionEstablished: (sessionId) => {
                executor.lastSeq = 0;
                executor.auth.sessionId = sessionId;
            },
            onRenewRejected: (error) => {
                auditCritical("renew_rejected", "fail_closed", { error });
            },
        });
    }

    // Native Messaging handlers (extension communication)
    const nativeMsg = new NativeMessaging();

    nativeMsg.onMessage("get_status", () => {
        nativeMsg.send({
            type: "status",
            connected: ws && ws.ws && ws.ws.readyState === 1,
            sessionId: ws ? ws.sessionId : null,
            cdpConnected: cdpReady,
            ownedTabs: tabManager.ownedTabs.size,
        });
    });

    // Tab handover: extension sends chromeTabId + URL + title.
    // Resolve to CDP target. Reject if ambiguous (>1 match = fail-closed).
    nativeMsg.onMessage("tab_handover", async (msg) => {
        if (!msg.url) {
            auditCritical("handover_rejected", "blocked", { error: "url required" });
            nativeMsg.send({ type: "handover_rejected", error: "url required" });
            return;
        }
        try {
            const targets = await cdp.getTargets();
            let matches = targets.filter(t => t.type === "page" && t.url === msg.url);

            if (matches.length > 1 && msg.title) {
                const titleMatches = matches.filter(t => t.title === msg.title);
                if (titleMatches.length > 0) {
                    matches = titleMatches;
                }
            }

            if (matches.length === 0) {
                const error = "no CDP target for URL: " + msg.url;
                auditCritical("handover_rejected", "blocked", { error, url: msg.url });
                nativeMsg.send({ type: "handover_rejected", error });
                return;
            }
            if (matches.length > 1) {
                const error = "ambiguous: " + matches.length + " tabs with same URL+title";
                auditCritical("handover_rejected", "blocked", { error, url: msg.url });
                nativeMsg.send({ type: "handover_rejected", error });
                return;
            }

            const target = matches[0];
            const chromeTabId = msg.tabId != null ? Number(msg.tabId) : null;

            tabManager.addTransferredTab(target.id, msg.url, chromeTabId);
            await cdp.attachToTarget(target.id);

            nativeMsg.send({
                type: "handover_accepted",
                targetId: target.id,
                chromeTabId: chromeTabId,
            });
            console.log(`[native-messaging] handover: chrome:${chromeTabId} -> cdp:${target.id} (${msg.url})`);
        } catch (err) {
            console.error("[native-messaging] handover error:", err.message);
            auditCritical("handover_rejected", "error", { error: err.message, url: msg.url });
            nativeMsg.send({ type: "handover_rejected", error: err.message });
        }
    });

    // Tab revoke: use stable chromeTabId -> targetId mapping.
    nativeMsg.onMessage("tab_revoke", (msg) => {
        const chromeTabId = msg.tabId != null ? Number(msg.tabId) : null;
        if (chromeTabId != null) {
            const info = tabManager.revokeByChomeTabId(chromeTabId);
            if (info) {
                console.log(`[native-messaging] tab_revoke: chrome:${chromeTabId} revoked`);
                return;
            }
        }
        auditCritical("tab_revoke_no_mapping", "warning", { chromeTabId });
        console.warn(`[native-messaging] tab_revoke: no mapping for chrome:${chromeTabId}`);
    });

    nativeMsg.onMessage("revoke_all", () => {
        const count = tabManager.ownedTabs.size;
        tabManager.revokeAll();
        auditCritical("revoke_all", "ok", { tabs_revoked: count });
        console.log("[native-messaging] revoke_all: AHVclaw group deleted");
    });

    // Extension confirms a helper-created tab was grouped.
    // This is the ONLY path that promotes pending -> owned.
    nativeMsg.onMessage("tab_grouped", (msg) => {
        const { targetId, chromeTabId } = msg;
        if (targetId && chromeTabId != null) {
            const ok = tabManager.confirmGrouped(targetId, Number(chromeTabId));
            if (ok) {
                console.log(`[native-messaging] tab_grouped confirmed: chrome:${chromeTabId} <-> cdp:${targetId}`);
            } else {
                console.warn(`[native-messaging] tab_grouped: no pending tab for ${targetId}`);
            }
        }
    });

    nativeMsg.onMessage("kill", () => {
        auditCritical("kill_switch", "triggered", { source: "extension" });
        killWithTimeout();
    });

    nativeMsg.onMessage("generate_keypair", () => {
        nativeMsg.send({
            type: "public_key",
            public_key: keypair.publicKeyPEM,
            device_id: keypair.deviceId,
        });
    });

    nativeMsg.onMessage("retry_cdp", async () => {
        if (cdpReady) {
            nativeMsg.send({ type: "retry_cdp_result", success: true, reason: "already_connected" });
            return;
        }
        try {
            await cdp.connect();
            cdpReady = true;
            console.log("[cdp] retry succeeded, connecting to server");
            nativeMsg.send({ type: "retry_cdp_result", success: true });
            ws = createWSClient();
            ws.connect();
        } catch (err) {
            console.error("[cdp] retry failed:", err.message);
            nativeMsg.send({ type: "retry_cdp_result", success: false, error: err.message });
        }
    });

    // Hook createTab: deferred ownership via createTabPending + NM round-trip.
    const origCreateTab = tabManager.createTab;
    tabManager.createTab = async function (url) {
        const { targetId, nonce, promise } = await tabManager.createTabPending(url);
        nativeMsg.send({
            type: "tab_created",
            targetId: targetId,
            nonce: nonce,
            url: url || "about:blank",
        });
        // Block until extension confirms grouping (or 5s timeout → reject)
        try {
            return await promise;
        } catch (err) {
            auditCritical("pending_timeout", "fail_closed", { targetId, url });
            throw err;
        }
    };

    // FAIL-CLOSED: connect to Chrome FIRST. Only go online if CDP succeeds.
    try {
        await cdp.connect();
        cdpReady = true;
        console.log("[cdp] browser connected, going online");
    } catch (err) {
        console.error("[cdp] failed to connect:", err.message);
        console.log("[helper] OFFLINE — waiting for extension retry_cdp or Chrome restart");
    }

    if (cdpReady) {
        ws = createWSClient();
        ws.connect();
    }

    if (process.stdin.isTTY === undefined) {
        nativeMsg.start();
    }

    process.on("SIGTERM", killWithTimeout);
    process.on("SIGINT", killWithTimeout);

    console.log(`[helper] AHVclaw Browser Companion started for user ${USER_ID} (CDP: ${cdpReady ? "ONLINE" : "OFFLINE"})`);
}

main().catch(err => {
    console.error("[helper] fatal:", err);
    process.exit(1);
});
