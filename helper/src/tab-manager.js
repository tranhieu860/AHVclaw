// /opt/ahvclaw/helper/src/tab-manager.js
// Tab group "AHVclaw" manager with ownership tracking.
// Deferred ownership: helper-created tabs stay in pendingTabs until extension
// confirms grouping (tab_grouped ack). Fail-closed: 5s timeout → close tab.
// Bidirectional chromeTabId <-> CDP targetId mapping for stable identity.
const CDP = require("chrome-remote-interface");
const crypto = require("crypto");

const PENDING_TIMEOUT_MS = 5000;

class TabManager {
    constructor(cdpManager) {
        this.cdp = cdpManager;
        this.ownedTabs = new Map();   // targetId -> { type, url_at_transfer, created_at, frozen?, chromeTabId? }
        this.pendingTabs = new Map(); // targetId -> { url, nonce, resolve, reject, timer }
        // Bidirectional map: chromeTabId <-> CDP targetId
        this.chromeToTarget = new Map();
        this.targetToChrome = new Map();
    }

    linkIds(chromeTabId, targetId) {
        this.chromeToTarget.set(chromeTabId, targetId);
        this.targetToChrome.set(targetId, chromeTabId);
        const info = this.ownedTabs.get(targetId);
        if (info) info.chromeTabId = chromeTabId;
    }

    getTargetId(chromeTabId) {
        return this.chromeToTarget.get(chromeTabId) || null;
    }

    getChromeTabId(targetId) {
        return this.targetToChrome.get(targetId) || null;
    }

    // Phase 1: Create CDP target with nonce title, put in pendingTabs.
    // Returns { targetId, nonce, promise }.
    // promise resolves to targetId when tab_grouped ack arrives.
    // Caller (index.js hook) sends tab_created NM between phase 1 and await.
    async createTabPending(url) {
        if (this.ownedTabs.size + this.pendingTabs.size >= 5) {
            throw new Error("Max 5 tabs in AHVclaw group");
        }

        // Create blank tab via CDP
        const browser = await CDP({ port: this.cdp.port });
        const { targetId } = await browser.Target.createTarget({ url: "about:blank" });
        await browser.close();

        // Attach temporarily ONLY to set unique title for extension to find.
        // Tab is NOT owned yet — isOwned() returns false.
        const client = await this.cdp.attachToTarget(targetId);
        const nonce = crypto.randomBytes(8).toString("hex");
        await client.Runtime.evaluate({
            expression: `document.title = '_ahvclaw_${nonce}'`,
        });

        // Create promise that resolves on confirmGrouped or rejects on timeout
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });

        const timer = setTimeout(() => {
            // FAIL-CLOSED: no ack → close tab, detach, reject
            const pending = this.pendingTabs.get(targetId);
            if (pending) {
                this.pendingTabs.delete(targetId);
                this.cdp.detachTarget(targetId);
                // Best-effort close the orphaned tab
                CDP({ port: this.cdp.port }).then(b => {
                    b.Target.closeTarget({ targetId });
                    b.close();
                }).catch(() => {});
                pending.reject(new Error("tab grouping timeout — tab closed (fail-closed)"));
            }
        }, PENDING_TIMEOUT_MS);

        this.pendingTabs.set(targetId, { url, nonce, resolve, reject, timer });
        return { targetId, nonce, promise };
    }

    // Phase 2: Extension confirmed tab is in AHVclaw group.
    // Promote from pending to owned, link IDs, navigate to real URL.
    confirmGrouped(targetId, chromeTabId) {
        const pending = this.pendingTabs.get(targetId);
        if (!pending) return false;

        clearTimeout(pending.timer);
        this.pendingTabs.delete(targetId);

        // NOW mark as owned
        this.ownedTabs.set(targetId, {
            type: "helper-created",
            url_at_transfer: pending.url,
            created_at: new Date(),
            chromeTabId: chromeTabId,
        });
        this.linkIds(Number(chromeTabId), targetId);

        // Navigate to actual URL (tab was about:blank with nonce title)
        if (pending.url && pending.url !== "about:blank") {
            const client = this.cdp.targets.get(targetId);
            if (client) {
                client.Page.navigate({ url: pending.url }).catch(() => {});
            }
        }

        console.log(`[tab] confirmed grouped: chrome:${chromeTabId} <-> cdp:${targetId} (${pending.url})`);
        pending.resolve(targetId);
        return true;
    }

    addTransferredTab(targetId, url, chromeTabId) {
        this.ownedTabs.set(targetId, {
            type: "user-transferred",
            url_at_transfer: url,
            created_at: new Date(),
            chromeTabId: chromeTabId,
        });
        if (chromeTabId != null) {
            this.linkIds(Number(chromeTabId), targetId);
        }
        console.log(`[tab] user transferred tab ${targetId} (chrome:${chromeTabId}, ${url})`);
    }

    isOwned(targetId) {
        const info = this.ownedTabs.get(targetId);
        if (!info) return false;
        if (info.frozen) return false;
        return true;
    }

    getTabInfo(targetId) {
        return this.ownedTabs.get(targetId);
    }

    revokeTab(targetId) {
        const info = this.ownedTabs.get(targetId);
        if (info) {
            this.ownedTabs.delete(targetId);
            this.cdp.detachTarget(targetId);
            const chromeId = this.targetToChrome.get(targetId);
            if (chromeId != null) {
                this.chromeToTarget.delete(chromeId);
                this.targetToChrome.delete(targetId);
            }
            console.log(`[tab] revoked tab ${targetId}`);
        }
        return info;
    }

    revokeByChomeTabId(chromeTabId) {
        const targetId = this.chromeToTarget.get(chromeTabId);
        if (targetId) {
            return this.revokeTab(targetId);
        }
        return null;
    }

    freezeTab(targetId) {
        const info = this.ownedTabs.get(targetId);
        if (info) {
            info.frozen = true;
            this.cdp.detachTarget(targetId);
            console.log(`[tab] froze tab ${targetId} (payment risk)`);
        }
    }

    revokeAll() {
        for (const [id] of this.ownedTabs) {
            this.cdp.detachTarget(id);
        }
        this.ownedTabs.clear();
        this.chromeToTarget.clear();
        this.targetToChrome.clear();
        // Also cancel any pending
        for (const [id, pending] of this.pendingTabs) {
            clearTimeout(pending.timer);
            this.cdp.detachTarget(id);
            pending.reject(new Error("revoke_all"));
        }
        this.pendingTabs.clear();
        console.log("[tab] revoked all tabs");
    }

    async closeHelperTabs() {
        const toClose = [];
        for (const [id, info] of this.ownedTabs) {
            if (info.type === "helper-created") {
                toClose.push(id);
            }
        }
        for (const id of toClose) {
            try {
                const browser = await CDP({ port: this.cdp.port });
                await browser.Target.closeTarget({ targetId: id });
                await browser.close();
            } catch {}
            const chromeId = this.targetToChrome.get(id);
            if (chromeId != null) {
                this.chromeToTarget.delete(chromeId);
                this.targetToChrome.delete(id);
            }
            this.ownedTabs.delete(id);
        }
    }

    async listTabs() {
        const targets = await this.cdp.getTargets();
        return targets
            .filter(t => t.type === "page")
            .map(t => ({
                id: t.id,
                url: t.url,
                title: t.title,
                owned: this.ownedTabs.has(t.id),
                pending: this.pendingTabs.has(t.id),
                type: this.ownedTabs.get(t.id)?.type || null,
                chromeTabId: this.targetToChrome.get(t.id) || null,
            }));
    }
}

module.exports = TabManager;
