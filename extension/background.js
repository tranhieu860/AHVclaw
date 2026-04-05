// AHVclaw Background Service Worker
// Maintains WebSocket connection to AGI server and dispatches commands

let ws = null;
let reconnectDelay = 3000;
const MAX_RECONNECT_DELAY = 30000;
let heartbeatInterval = null;
let isEnabled = false;
let serverUrl = "wss://api.ahvclaw.com/ws/computer-use";
let authToken = "";
let refreshToken = "";
let activityLog = [];
const MAX_LOG_ENTRIES = 50;
const API_BASE = "https://api.ahvclaw.com";

// --- Initialization ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["enabled", "serverUrl", "token", "refreshToken"], (data) => {
    isEnabled = data.enabled || false;
    serverUrl = data.serverUrl || "wss://api.ahvclaw.com/ws/computer-use";
    authToken = data.token || "";
    refreshToken = data.refreshToken || "";
    updateBadge();
    if (isEnabled && authToken) connect();
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(["enabled", "serverUrl", "token", "refreshToken"], (data) => {
    isEnabled = data.enabled || false;
    serverUrl = data.serverUrl || "wss://api.ahvclaw.com/ws/computer-use";
    authToken = data.token || "";
    refreshToken = data.refreshToken || "";
    updateBadge();
    if (isEnabled && authToken) connect();
  });
});

// --- React to popup toggle / settings changes ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled !== undefined) {
    isEnabled = changes.enabled.newValue;
    if (isEnabled && authToken) {
      connect();
    } else {
      disconnect();
    }
    updateBadge();
  }
  if (changes.serverUrl !== undefined) {
    serverUrl = changes.serverUrl.newValue;
    if (isEnabled) { disconnect(); connect(); }
  }
  if (changes.token !== undefined) {
    authToken = changes.token.newValue;
    if (isEnabled && authToken) { disconnect(); connect(); }
  }
  if (changes.refreshToken !== undefined) {
    refreshToken = changes.refreshToken.newValue;
  }
});

// --- Badge ---
function updateBadge() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  } else {
    chrome.action.setBadgeText({ text: isEnabled ? "..." : "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: isEnabled ? "#FF9800" : "#F44336" });
  }
}

// --- Activity Log ---
function logActivity(action, detail) {
  const entry = { action, detail, time: Date.now() };
  activityLog.unshift(entry);
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
  chrome.storage.local.set({ activityLog: activityLog.slice(0, 10) });
}

// --- Token Refresh ---
async function tryRefreshToken() {
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken })
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
      logActivity("refreshed", "Token refreshed successfully");
      return true;
    }
  } catch (e) {
    logActivity("error", "Token refresh failed: " + e.message);
  }
  return false;
}

// --- WebSocket Connection ---
let authRetried = false;

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!authToken) return;

  const url = serverUrl.includes("?") ? `${serverUrl}&token=${authToken}` : `${serverUrl}?token=${authToken}`;
  
  try {
    ws = new WebSocket(url);
  } catch (e) {
    logActivity("error", "WebSocket creation failed: " + e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[AHVclaw] Connected to server");
    reconnectDelay = 3000;
    authRetried = false;
    updateBadge();
    logActivity("connected", serverUrl);

    // Send initial handshake
    wsSend({
      type: "extension_hello",
      version: "1.0.0",
      capabilities: ["screenshot", "click", "type", "scroll", "navigate", "read_page", "tab_list", "tab_switch"]
    });

    // Start heartbeat
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: "heartbeat", timestamp: Date.now() });
      }
    }, 30000);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error("[AHVclaw] Invalid message:", event.data);
      return;
    }
    handleServerMessage(msg);
  };

  ws.onclose = async (event) => {
    console.log("[AHVclaw] Disconnected:", event.code, event.reason);
    cleanup();
    updateBadge();

    // 401 = auth failed, try refresh token once
    if ((event.code === 1008 || event.code === 4001 || event.code === 1006) && !authRetried) {
      authRetried = true;
      logActivity("auth", "Token expired, refreshing...");
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        connect();
        return;
      }
    }

    logActivity("disconnected", `Code: ${event.code}`);
    if (isEnabled) scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error("[AHVclaw] WebSocket error");
    logActivity("error", "Connection error");
  };
}

function disconnect() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  cleanup();
  updateBadge();
}

function cleanup() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
  ws = null;
}

function scheduleReconnect() {
  setTimeout(() => {
    if (isEnabled && authToken) connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// --- Tab tracking ---
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    wsSend({ type: "tab_changed", tabId: tab.id, url: tab.url, title: tab.title });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (changeInfo.status === "complete" && tab.active) {
    wsSend({ type: "page_loaded", tabId, url: tab.url, title: tab.title });
  }
});

// --- Command Handling ---
// Server sends CUCommand: { id, action, params }
// We respond with CUResult: { id, status, data, error }
async function handleServerMessage(msg) {
  // Heartbeat responses
  if (msg.type === "heartbeat_ack" || msg.type === "pong") return;

  // Detect command by presence of 'action' field (server CUCommand format)
  if (!msg.action) return;

  const { id, action, params } = msg;
  const parsedParams = typeof params === "string" ? JSON.parse(params) : (params || {});
  
  logActivity(action, JSON.stringify(parsedParams).substring(0, 100));

  try {
    let result;
    switch (action) {
      case "screenshot":
        result = await handleScreenshot();
        break;
      case "click":
      case "type":
      case "scroll":
      case "read_page":
        result = await forwardToContent(action, parsedParams);
        break;
      case "navigate":
        result = await handleNavigate(parsedParams);
        break;
      case "tab_list":
        result = await handleTabList();
        break;
      case "tab_switch":
        result = await handleTabSwitch(parsedParams);
        break;
      default:
        result = { success: false, error: `Unknown action: ${action}` };
    }

    // Send CUResult format: { id, status, data, error }
    if (result.success) {
      wsSend({ id, status: "ok", data: result.data || {} });
    } else {
      wsSend({ id, status: "error", error: result.error || "unknown error" });
    }
  } catch (err) {
    wsSend({ id, status: "error", error: err.message });
  }
}

// --- Screenshot ---
async function handleScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: "No active tab" };

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 80 });
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    return { success: true, data: { screenshot: base64, url: tab.url, title: tab.title } };
  } catch (err) {
    return { success: false, error: "Screenshot failed: " + err.message };
  }
}

// --- Forward to content script ---
async function forwardToContent(action, params) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: "No active tab" };

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (e) {
    // content script may already be there
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { action, params }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else if (response && response.success) {
        // Enrich content script response with tab info
        const data = response.data || {};
        data.url = tab.url;
        data.title = tab.title;
        resolve({ success: true, data });
      } else {
        resolve(response || { success: false, error: "No response from content script" });
      }
    });
  });
}

// --- Navigate ---
async function handleNavigate(params) {
  const url = params && params.url;
  if (!url) return { success: false, error: "No URL provided" };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: "No active tab" };

  return new Promise((resolve) => {
    chrome.tabs.update(tab.id, { url }, () => {
      const listener = (tabId, changeInfo, updatedTab) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({ success: true, data: { url: updatedTab.url || url, title: updatedTab.title || "" } });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ success: true, data: { url, title: "", note: "timeout waiting for load" } });
      }, 30000);
    });
  });
}

// --- Tab List ---
async function handleTabList() {
  const tabs = await chrome.tabs.query({});
  const list = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
  return { success: true, data: { tabs: list } };
}

// --- Tab Switch ---
async function handleTabSwitch(params) {
  const tabId = params && (params.tab_id || params.tabId);
  if (!tabId) return { success: false, error: "No tab_id provided" };

  try {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    return { success: true, data: { url: tab.url, title: tab.title } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
