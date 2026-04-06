// /opt/ahvclaw/helper/src/tab-manager.js
// Tab group "AHVclaw" manager with ownership tracking.
// Maintains bidirectional chromeTabId <-> CDP targetId mapping for stable identity.
const CDP = require("chrome-remote-interface");

class TabManager {
    constructor(cdpManager) {
        this.cdp = cdpManager;
        this.ownedTabs = new Map(); // targetId -> { type, url_at_transfer, created_at, frozen?, chromeTabId? }
        // Bidirectional map: chromeTabId <-> CDP targetId
        this.chromeToTarget = new Map(); // chromeTabId (number) -> targetId (string)
        this.targetToChrome = new Map(); // targetId (string) -> chromeTabId (number)
    }

    // Store bidirectional mapping
    linkIds(chromeTabId, targetId) {
        this.chromeToTarget.set(chromeTabId, targetId);
        this.targetToChrome.set(targetId, chromeTabId);
        const info = this.ownedTabs.get(targetId);
        if (info) info.chromeTabId = chromeTabId;
    }

    // Lookup targetId from chromeTabId
    getTargetId(chromeTabId) {
        return this.chromeToTarget.get(chromeTabId) || null;
    }

    // Lookup chromeTabId from targetId
    getChromeTabId(targetId) {
        return this.targetToChrome.get(targetId) || null;
    }

    async createTab(url) {
        if (this.ownedTabs.size >= 5) {
            throw new Error("Max 5 tabs in AHVclaw group");
        }

        const browser = await CDP({ port: this.cdp.port });
        const { targetId } = await browser.Target.createTarget({
            url: url || "about:blank",
        });
        await browser.close();

        this.ownedTabs.set(targetId, {
            type: "helper-created",
            url_at_transfer: url || "about:blank",
            created_at: new Date(),
        });

        await this.cdp.attachToTarget(targetId);
        console.log(`[tab] created tab ${targetId} for ${url}`);
        return targetId;
    }

    addTransferredTab(targetId, url, chromeTabId) {
        this.ownedTabs.set(targetId, {
            type: "user-transferred",
            url_at_transfer: url,
            created_at: new Date(),
            chromeTabId: chromeTabId,
        });
        if (chromeTabId != null) {
            this.linkIds(chromeTabId, targetId);
        }
        console.log(`[tab] user transferred tab ${targetId} (chrome:${chromeTabId}, ${url})`);
    }

    isOwned(targetId) {
        const info = this.ownedTabs.get(targetId);
        if (!info) return false;
        if (info.frozen) return false; // frozen tabs are not actionable
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
            // Clean up bidirectional map
            const chromeId = this.targetToChrome.get(targetId);
            if (chromeId != null) {
                this.chromeToTarget.delete(chromeId);
                this.targetToChrome.delete(targetId);
            }
            console.log(`[tab] revoked tab ${targetId}`);
        }
        return info;
    }

    // Revoke by chromeTabId — stable identity, no URL ambiguity
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
            // Clean up maps
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
                type: this.ownedTabs.get(t.id)?.type || null,
                chromeTabId: this.targetToChrome.get(t.id) || null,
            }));
    }
}

module.exports = TabManager;
