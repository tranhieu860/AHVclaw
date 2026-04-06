// AHVclaw Companion Extension v2 — Popup Script
// Displays helper status, consent UI, kill switch.
const API_BASE = "https://api.ahvclaw.com";

// Elements
const helperStatusText = document.getElementById("helperStatusText");
const cdpStatusText = document.getElementById("cdpStatusText");
const serverStatusText = document.getElementById("serverStatusText");
const tabCountText = document.getElementById("tabCountText");
const loginForm = document.getElementById("loginForm");
const loggedInBox = document.getElementById("loggedInBox");
const loggedInInfo = document.getElementById("loggedInInfo");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginMsg = document.getElementById("loginMsg");
const logoutBtn = document.getElementById("logoutBtn");
const grantStatus = document.getElementById("grantStatus");
const grantBtn = document.getElementById("grantBtn");
const revokeBtn = document.getElementById("revokeBtn");
const retryCDPBtn = document.getElementById("retryCDPBtn");
const killBtn = document.getElementById("killBtn");

// ─── Load state ─────────────────────────────────────────────────────────

chrome.storage.local.get(["token", "userEmail", "helperStatus", "grantRegistered"], (data) => {
    if (data.userEmail && data.token) {
        showLoggedIn(data.userEmail);
    }
    updateHelperUI(data.helperStatus || {});
    updateGrantUI(data.grantRegistered || false, data.helperStatus || {});
});

// Poll helper status on open
chrome.runtime.sendMessage({ type: "get_helper_status" }, (status) => {
    if (status) updateHelperUI(status);
});

// Watch for status changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.helperStatus) {
        updateHelperUI(changes.helperStatus.newValue || {});
    }
    if (changes.grantRegistered) {
        chrome.storage.local.get(["helperStatus"], (data) => {
            updateGrantUI(changes.grantRegistered.newValue, data.helperStatus || {});
        });
    }
});

// ─── Status UI ──────────────────────────────────────────────────────────

function updateHelperUI(status) {
    // Helper process
    if (status.connected) {
        helperStatusText.textContent = "Online";
        helperStatusText.className = "status-value online";
    } else {
        helperStatusText.textContent = "Offline";
        helperStatusText.className = "status-value offline";
    }

    // CDP / browser
    if (status.cdpConnected) {
        cdpStatusText.textContent = "Connected";
        cdpStatusText.className = "status-value online";
        retryCDPBtn.style.display = "none";
    } else if (status.connected) {
        cdpStatusText.textContent = "Disconnected";
        cdpStatusText.className = "status-value offline";
        retryCDPBtn.style.display = "block";
    } else {
        cdpStatusText.textContent = "N/A";
        cdpStatusText.className = "status-value offline";
        retryCDPBtn.style.display = "none";
    }

    // Server session
    if (status.sessionId) {
        serverStatusText.textContent = "Connected";
        serverStatusText.className = "status-value online";
    } else if (status.connected) {
        serverStatusText.textContent = "Handshake...";
        serverStatusText.className = "status-value waiting";
    } else {
        serverStatusText.textContent = "Offline";
        serverStatusText.className = "status-value offline";
    }

    // Tab count
    tabCountText.textContent = String(status.ownedTabs || 0);
}

function updateGrantUI(granted, status) {
    if (granted) {
        grantStatus.textContent = "Thiết bị đã được cấp quyền";
        grantStatus.className = "grant-status active";
        grantBtn.style.display = "none";
        revokeBtn.style.display = "block";
    } else {
        grantStatus.textContent = "Chưa cấp quyền cho thiết bị này";
        grantStatus.className = "grant-status inactive";
        grantBtn.style.display = "block";
        revokeBtn.style.display = "none";
    }
}

// ─── Login ──────────────────────────────────────────────────────────────

loginBtn.addEventListener("click", async () => {
    const email = loginEmail.value.trim();
    const password = loginPassword.value.trim();
    if (!email || !password) {
        showMsg("Vui lòng nhập email và mật khẩu", true);
        return;
    }
    loginBtn.disabled = true;
    loginBtn.textContent = "Đang đăng nhập...";
    try {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
            showMsg(data.error || "Đăng nhập thất bại", true);
            return;
        }
        chrome.storage.local.set({
            token: data.access_token,
            refreshToken: data.refresh_token,
            userEmail: email,
        });
        showMsg("Đăng nhập thành công!", false);
        showLoggedIn(email);
    } catch (e) {
        showMsg("Lỗi kết nối: " + e.message, true);
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "Đăng nhập";
    }
});

logoutBtn.addEventListener("click", () => {
    chrome.storage.local.remove(["token", "refreshToken", "userEmail", "grantRegistered"]);
    loginForm.style.display = "block";
    loggedInBox.style.display = "none";
});

function showLoggedIn(email) {
    loginForm.style.display = "none";
    loggedInBox.style.display = "block";
    loggedInInfo.textContent = "Đã đăng nhập: " + email;
}

function showMsg(msg, isError) {
    loginMsg.textContent = msg;
    loginMsg.className = "msg " + (isError ? "error" : "success");
    setTimeout(() => { loginMsg.textContent = ""; }, 3000);
}

// ─── Grant / Revoke ─────────────────────────────────────────────────────

grantBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "init_grant" });
    grantBtn.disabled = true;
    grantBtn.textContent = "Đang tạo khóa...";
    setTimeout(() => {
        grantBtn.disabled = false;
        grantBtn.textContent = "Cấp quyền cho thiết bị này";
    }, 5000);
});

revokeBtn.addEventListener("click", () => {
    if (confirm("Thu hồi quyền điều khiển trình duyệt cho thiết bị này?")) {
        chrome.runtime.sendMessage({ type: "revoke_grant" });
    }
});

// ─── Retry CDP ──────────────────────────────────────────────────────────

retryCDPBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "retry_cdp" });
    retryCDPBtn.disabled = true;
    retryCDPBtn.textContent = "Đang kết nối...";
    setTimeout(() => {
        retryCDPBtn.disabled = false;
        retryCDPBtn.textContent = "Kết nối lại Chrome";
    }, 5000);
});

// ─── Kill Switch ────────────────────────────────────────────────────────

killBtn.addEventListener("click", () => {
    if (confirm("Dừng ngay toàn bộ điều khiển AGI? Hành động này thu hồi mọi quyền.")) {
        chrome.runtime.sendMessage({ type: "kill_switch" });
        killBtn.textContent = "Đã dừng";
        killBtn.disabled = true;
        setTimeout(() => {
            killBtn.textContent = "Dừng ngay";
            killBtn.disabled = false;
        }, 3000);
    }
});
