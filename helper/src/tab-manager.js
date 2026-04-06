// /opt/ahvclaw/helper/src/tab-manager.js
// Tab group "AHVclaw" manager with ownership tracking.
const CDP = require("chrome-remote-interface");

class TabManager {
    constructor(cdpManager) {
        this.cdp = cdpManager;
        this.ownedTabs = new Map(); // targetId -> { type, url_at_transfer, created_at, frozen? }
    }

    async createTab(url) {
        if (this.ownedTabs.size >= 5) {
            throw new Error("Max 5 tabs in AHVclaw group");
        }

        const targets = await this.cdp.getTargets();
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

    addTransferredTab(targetId, url) {
        this.ownedTabs.set(targetId, {
            type: "user-transferred",
            url_at_transfer: url,
            created_at: new Date(),
        });
        console.log(`[tab] user transferred tab ${targetId} (${url})`);
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
            console.log(`[tab] revoked tab ${targetId}`);
        }
        return info;
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
            }));
    }
}

module.exports = TabManager;
