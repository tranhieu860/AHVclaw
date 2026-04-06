// AHVclaw Companion Extension v2 — Background Service Worker
// NO automation. All automation is done by Native Helper via CDP.
// This service worker handles: auth, tab group monitoring, native messaging bridge.

const HELPER_NAME = "com.ahvholding.ahvclaw_helper";
const API_BASE = "https://api.ahvclaw.com";
const GROUP_TITLE = "AHVclaw";

let helperPort = null;
let ahvclawGroupId = null;
let helperStatus = { connected: false, cdpConnected: false, sessionId: null, ownedTabs: 0 };
let authToken = "";
let refreshToken = "";

// ─── Initialization ─────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    loadSettings();
});

chrome.runtime.onStartup.addListener(() => {
    loadSettings();
});

function loadSettings() {
    chrome.storage.local.get(["token", "refreshToken"], (data) => {
        authToken = data.token || "";
        refreshToken = data.refreshToken || "";
        if (authToken) {
            connectHelper();
        }
        updateBadge();
    });
}

// React to storage changes (login/logout from popup)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.token) {
        authToken = changes.token.newValue || "";
        if (authToken && !helperPort) {
            connectHelper();
        } else if (!authToken && helperPort) {
            disconnectHelper();
        }
    }
    if (changes.refreshToken) {
        refreshToken = changes.refreshToken.newValue || "";
    }
});

// ─── Native Messaging ───────────────────────────────────────────────────

function connectHelper() {
    if (helperPort) return;
    try {
        helperPort = chrome.runtime.connectNative(HELPER_NAME);
    } catch (err) {
        console.error("[bg] cannot connect to helper:", err);
        helperStatus = { connected: false, cdpConnected: false, sessionId: null, ownedTabs: 0 };
        updateBadge();
        return;
    }

    helperPort.onMessage.addListener((msg) => {
        switch (msg.type) {
            case "status":
                helperStatus = {
                    connected: msg.connected || false,
                    cdpConnected: msg.cdpConnected || false,
                    sessionId: msg.sessionId || null,
                    ownedTabs: msg.ownedTabs || 0,
                };
                updateBadge();
                chrome.storage.local.set({ helperStatus });
                break;
            case "public_key":
                // Helper generated keypair — register with server
                registerGrant(msg.public_key, msg.device_id);
                break;
            case "handover_accepted":
                console.log("[bg] tab handover accepted:", msg.targetId);
                break;
            case "retry_cdp_result":
                console.log("[bg] CDP retry:", msg.success ? "OK" : msg.error);
                if (msg.success) {
                    requestHelperStatus();
                }
                chrome.storage.local.set({ lastCDPRetry: msg });
                break;
        }
    });

    helperPort.onDisconnect.addListener(() => {
        console.log("[bg] helper disconnected:", chrome.runtime.lastError?.message);
        helperPort = null;
        helperStatus = { connected: false, cdpConnected: false, sessionId: null, ownedTabs: 0 };
        updateBadge();
        chrome.storage.local.set({ helperStatus });
    });

    // Request initial status
    requestHelperStatus();
}

function disconnectHelper() {
    if (helperPort) {
        helperPort.disconnect();
        helperPort = null;
    }
    helperStatus = { connected: false, cdpConnected: false, sessionId: null, ownedTabs: 0 };
    updateBadge();
    chrome.storage.local.set({ helperStatus });
}

function sendToHelper(msg) {
    if (helperPort) {
        helperPort.postMessage(msg);
    }
}

function requestHelperStatus() {
    sendToHelper({ type: "get_status" });
}

// ─── Grant Registration ─────────────────────────────────────────────────

async function registerGrant(publicKey, deviceId) {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_BASE}/api/companion/grant`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${authToken}`,
            },
            body: JSON.stringify({ device_id: deviceId, public_key: publicKey }),
        });
        if (!res.ok) {
            console.error("[bg] grant registration failed:", await res.text());
            return;
        }
        console.log("[bg] grant registered for device:", deviceId);
        chrome.storage.local.set({ grantRegistered: true, deviceId });
    } catch (err) {
        console.error("[bg] grant registration error:", err);
    }
}

// ─── Tab Group Monitoring ───────────────────────────────────────────────

async function findAHVclawGroup() {
    try {
        const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
        if (groups.length > 0) {
            ahvclawGroupId = groups[0].id;
        }
    } catch {}
}

// Detect AHVclaw group creation/update
chrome.tabGroups.onUpdated.addListener((group) => {
    if (group.title === GROUP_TITLE) {
        ahvclawGroupId = group.id;
    }
});

// Detect tab moved INTO AHVclaw group (user handover)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.groupId === undefined) return;

    if (changeInfo.groupId === ahvclawGroupId && ahvclawGroupId !== null) {
        // Tab moved INTO group — prompt handover consent
        const confirmed = await showHandoverConfirm(tab);
        if (confirmed) {
            sendToHelper({
                type: "tab_handover",
                targetId: String(tabId),
                url: tab.url,
                title: tab.title,
            });
        } else {
            // User declined — remove from group
            try { chrome.tabs.ungroup(tabId); } catch {}
        }
    } else if (ahvclawGroupId !== null && changeInfo.groupId !== ahvclawGroupId) {
        // Tab moved OUT of group — notify helper to revoke
        sendToHelper({
            type: "tab_revoke",
            targetId: String(tabId),
        });
    }
});

// Detect tab closed
chrome.tabs.onRemoved.addListener((tabId) => {
    sendToHelper({
        type: "tab_revoke",
        targetId: String(tabId),
    });
});

// Detect group deleted
chrome.tabGroups.onRemoved.addListener((group) => {
    if (group.id === ahvclawGroupId) {
        ahvclawGroupId = null;
        sendToHelper({ type: "revoke_all" });
    }
});

async function showHandoverConfirm(tab) {
    // Use simple notification approach — V2 could use a dedicated confirm dialog
    const title = tab.title || tab.url || "tab";
    // For V1, auto-confirm if tab is in AHVclaw group (user explicitly dragged it)
    // The act of dragging into the named group IS the consent gesture.
    console.log(`[bg] tab handover: ${title}`);
    return true;
}

// ─── Kill Switch (from popup) ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "kill_switch") {
        sendToHelper({ type: "kill" });
        // Also call server kill endpoint
        serverKill();
        sendResponse({ ok: true });
    }
    if (msg.type === "retry_cdp") {
        sendToHelper({ type: "retry_cdp" });
        sendResponse({ ok: true });
    }
    if (msg.type === "get_helper_status") {
        requestHelperStatus();
        sendResponse(helperStatus);
    }
    if (msg.type === "init_grant") {
        sendToHelper({ type: "generate_keypair" });
        sendResponse({ ok: true });
    }
    if (msg.type === "revoke_grant") {
        serverRevoke();
        sendResponse({ ok: true });
    }
    return true; // async response
});

async function serverKill() {
    if (!authToken) return;
    try {
        await fetch(`${API_BASE}/api/companion/kill`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${authToken}` },
        });
    } catch (err) {
        console.error("[bg] server kill error:", err);
    }
}

async function serverRevoke() {
    if (!authToken) return;
    const data = await chrome.storage.local.get(["deviceId"]);
    if (!data.deviceId) return;
    try {
        await fetch(`${API_BASE}/api/companion/revoke`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${authToken}`,
            },
            body: JSON.stringify({ device_id: data.deviceId }),
        });
        chrome.storage.local.set({ grantRegistered: false });
    } catch (err) {
        console.error("[bg] server revoke error:", err);
    }
}

// ─── Token Refresh ──────────────────────────────────────────────────────

async function tryRefreshToken() {
    if (!refreshToken) return false;
    try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data.access_token) {
            authToken = data.access_token;
            chrome.storage.local.set({ token: authToken });
            if (data.refresh_token) {
                refreshToken = data.refresh_token;
                chrome.storage.local.set({ refreshToken });
            }
            return true;
        }
    } catch {}
    return false;
}

// ─── Badge ──────────────────────────────────────────────────────────────

function updateBadge() {
    if (helperStatus.connected && helperStatus.cdpConnected) {
        chrome.action.setBadgeText({ text: "ON" });
        chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
    } else if (helperPort) {
        chrome.action.setBadgeText({ text: "..." });
        chrome.action.setBadgeBackgroundColor({ color: "#FF9800" });
    } else {
        chrome.action.setBadgeText({ text: "OFF" });
        chrome.action.setBadgeBackgroundColor({ color: "#F44336" });
    }
}

// Init
findAHVclawGroup();
