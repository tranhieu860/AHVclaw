// AHVclaw Popup Script
const API_BASE = "https://api.ahvclaw.com";

const serverUrlInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const enableToggle = document.getElementById("enableToggle");
const statusDot = document.getElementById("statusDot");
const logList = document.getElementById("logList");
const disconnectBtn = document.getElementById("disconnectBtn");

const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginMsg = document.getElementById("loginMsg");
const loginForm = document.getElementById("loginForm");
const loggedInBox = document.getElementById("loggedInBox");
const loggedInInfo = document.getElementById("loggedInInfo");
const logoutBtn = document.getElementById("logoutBtn");

// Tabs
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// Load saved settings
chrome.storage.local.get(["serverUrl", "token", "refreshToken", "enabled", "activityLog", "userEmail"], (data) => {
  serverUrlInput.value = data.serverUrl || "wss://api.ahvclaw.com/ws/computer-use";
  tokenInput.value = data.token || "";
  enableToggle.checked = data.enabled || false;
  updateStatus(data.enabled);
  renderLog(data.activityLog || []);

  if (data.userEmail && data.token) {
    showLoggedIn(data.userEmail);
  }
});

// Login
loginBtn.addEventListener("click", async () => {
  const email = loginEmail.value.trim();
  const password = loginPassword.value.trim();
  if (!email || !password) {
    showLoginMsg("Vui lòng nhập email và mật khẩu", true);
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = "Đang đăng nhập...";
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      showLoginMsg(data.error || "Đăng nhập thất bại", true);
      return;
    }
    chrome.storage.local.set({
      token: data.access_token,
      refreshToken: data.refresh_token,
      userEmail: email
    });
    showLoginMsg("Đăng nhập thành công!", false);
    showLoggedIn(email);
  } catch (e) {
    showLoginMsg("Lỗi kết nối: " + e.message, true);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Đăng nhập";
  }
});

// Logout
logoutBtn.addEventListener("click", () => {
  chrome.storage.local.remove(["token", "refreshToken", "userEmail"]);
  chrome.storage.local.set({ enabled: false });
  enableToggle.checked = false;
  tokenInput.value = "";
  loginForm.style.display = "block";
  loggedInBox.style.display = "none";
  updateStatus(false);
});

function showLoggedIn(email) {
  loginForm.style.display = "none";
  loggedInBox.style.display = "block";
  loggedInInfo.textContent = "Đã đăng nhập: " + email;
}

function showLoginMsg(msg, isError) {
  loginMsg.textContent = msg;
  loginMsg.className = "msg " + (isError ? "error" : "success");
  setTimeout(() => { loginMsg.textContent = ""; }, 3000);
}

// Save server URL
serverUrlInput.addEventListener("change", () => {
  chrome.storage.local.set({ serverUrl: serverUrlInput.value.trim() });
});

// Save token (manual)
tokenInput.addEventListener("change", () => {
  chrome.storage.local.set({ token: tokenInput.value.trim() });
});

// Toggle
enableToggle.addEventListener("change", () => {
  const enabled = enableToggle.checked;
  chrome.storage.local.set({ enabled });
  updateStatus(enabled);
});

// Disconnect
disconnectBtn.addEventListener("click", () => {
  enableToggle.checked = false;
  chrome.storage.local.set({ enabled: false });
  updateStatus(false);
});

function updateStatus(enabled) {
  if (enabled) {
    statusDot.classList.add("connected");
  } else {
    statusDot.classList.remove("connected");
  }
}

function renderLog(entries) {
  if (!entries || entries.length === 0) {
    logList.innerHTML = '<div class="empty-log">Chưa có hoạt động</div>';
    return;
  }
  logList.innerHTML = entries.map(entry => {
    const time = new Date(entry.time);
    const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const detail = (entry.detail || "").substring(0, 50);
    return `<div class="log-item">
      <span class="action">${escapeHtml(entry.action)}</span>
      <span class="detail">${escapeHtml(detail)}</span>
      <span class="time">${timeStr}</span>
    </div>`;
  }).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.activityLog) renderLog(changes.activityLog.newValue || []);
});
