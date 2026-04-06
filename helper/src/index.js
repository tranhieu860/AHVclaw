// /opt/ahvclaw/helper/src/index.js
// AHVclaw Browser Companion Native Helper — entry point with lifecycle.
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

async function main() {
    const cdp = new CDPManager();
    const tabManager = new TabManager(cdp);
    const security = new Security();
    const audit = new AuditLogger(TOKEN);
    const keypair = await Keypair.loadOrGenerate();
    const executor = new CommandExecutor(cdp, tabManager, security, audit);
    const nativeMsg = new NativeMessaging();

    let killing = false;

    async function killSwitch() {
        if (killing) return;
        killing = true;
        console.log("[kill] step 1: stop accepting commands");
        executor.accepting = false;

        console.log("[kill] step 2: clear pending queue");
        executor.clearPending("session_killed");

        console.log("[kill] step 3: detach CDP");
        await cdp.detachAll();

        console.log("[kill] step 4: close helper-created tabs");
        await tabManager.closeHelperTabs();

        console.log("[kill] step 5: exit");
        ws.close();
        process.exit(0);
    }

    function killWithTimeout() {
        killSwitch();
        setTimeout(() => {
            console.log("[kill] force exit after 5s timeout");
            process.exit(1);
        }, 5000);
    }

    const ws = new WSClient(SERVER_URL, {
        token: TOKEN,
        onCommand: (cmd) => executor.execute(cmd, ws),
        onKill: killWithTimeout,
        onConnected: () => {
            // Send signed hello after WebSocket connects
            const nonce = crypto.randomBytes(16).toString("hex");
            const payloadObj = {
                user_id: "from_token", // server extracts from JWT
                device_id: keypair.deviceId,
                helper_version: "1.0.0",
                timestamp: new Date().toISOString(),
                nonce: nonce,
            };
            const payloadStr = JSON.stringify(payloadObj);
            const signature = keypair.sign(payloadStr);

            ws.sendHello({
                type: "helper_hello",
                user_id: "from_token",
                device_id: keypair.deviceId,
                helper_version: "1.0.0",
                signature: signature,
                signed_payload: Buffer.from(payloadStr).toString("base64"),
            });
        },
    });

    // Native Messaging handlers (extension communication)
    nativeMsg.onMessage("get_status", () => {
        nativeMsg.send({
            type: "status",
            connected: ws.ws && ws.ws.readyState === 1,
            sessionId: ws.sessionId,
            cdpConnected: cdp.port !== null,
            ownedTabs: tabManager.ownedTabs.size,
        });
    });

    nativeMsg.onMessage("tab_handover", (msg) => {
        if (msg.targetId && msg.url) {
            tabManager.addTransferredTab(msg.targetId, msg.url);
            cdp.attachToTarget(msg.targetId).catch(err => {
                console.error("[native-messaging] attach error:", err.message);
            });
            nativeMsg.send({ type: "handover_accepted", targetId: msg.targetId });
        }
    });

    nativeMsg.onMessage("kill", () => {
        killWithTimeout();
    });

    nativeMsg.onMessage("generate_keypair", () => {
        // Keypair already loaded/generated at startup
        nativeMsg.send({
            type: "public_key",
            public_key: keypair.publicKeyPEM,
            device_id: keypair.deviceId,
        });
    });

    // Connect to Chrome
    try {
        await cdp.connect();
    } catch (err) {
        console.error("[cdp] failed to connect:", err.message);
        // Continue running — server gets companion_unavailable via status
    }

    // Connect to server
    ws.connect();

    // Start native messaging listener (for extension communication)
    if (process.stdin.isTTY === undefined) {
        // Only start if stdin is piped (running via Native Messaging)
        nativeMsg.start();
    }

    // Handle process signals
    process.on("SIGTERM", killWithTimeout);
    process.on("SIGINT", killWithTimeout);

    console.log("[helper] AHVclaw Browser Companion started");
}

main().catch(err => {
    console.error("[helper] fatal:", err);
    process.exit(1);
});
