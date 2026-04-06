// Parse query params
const params = new URLSearchParams(window.location.search);
const tabId = parseInt(params.get("tabId"), 10);
const title = params.get("title") || "Unknown";
const url = params.get("url") || "";

document.getElementById("title").textContent = title;
document.getElementById("url").textContent = url;

function respond(confirmed) {
    chrome.runtime.sendMessage({
        type: "handover_confirm_result",
        tabId: tabId,
        confirmed: confirmed,
    }, () => {
        window.close();
    });
}

document.getElementById("confirmBtn").addEventListener("click", () => respond(true));
document.getElementById("cancelBtn").addEventListener("click", () => respond(false));

// Close = cancel
window.addEventListener("beforeunload", () => {
    // Best-effort cancel if user closes window
    chrome.runtime.sendMessage({
        type: "handover_confirm_result",
        tabId: tabId,
        confirmed: false,
    });
});
