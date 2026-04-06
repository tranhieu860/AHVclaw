// /opt/ahvclaw/helper/src/command-executor.js
// Dispatch commands (navigate, extract, click, etc.) to CDP with security checks.

class CommandExecutor {
    constructor(cdpManager, tabManager, security, auditLogger) {
        this.cdp = cdpManager;
        this.tabs = tabManager;
        this.security = security;
        this.audit = auditLogger;
        this.accepting = true;
        this.pending = new Map(); // commandId -> reject function
    }

    clearPending(reason) {
        for (const [id, reject] of this.pending) {
            reject({ id, status: "error", error: reason });
        }
        this.pending.clear();
    }

    async execute(cmd, ws) {
        const startTime = Date.now();
        let result;

        if (!this.accepting) {
            result = { id: cmd.id, status: "error", error: "session_killed" };
            ws.sendResult(result);
            return;
        }

        try {
            // Validate command expiry
            if (cmd.expires_at) {
                const expiry = new Date(cmd.expires_at);
                if (Date.now() > expiry.getTime()) {
                    result = { id: cmd.id, status: "error", error: "expired" };
                    ws.sendResult(result);
                    return;
                }
            }

            // Rate limit check
            const rateBlock = this.security.checkRateLimit();
            if (rateBlock) {
                result = { id: cmd.id, status: "blocked", error: rateBlock, blocked_reason: "rate_limit" };
                ws.sendResult(result);
                this.audit.log(cmd, result);
                return;
            }

            // Loop check
            const loopBlock = this.security.checkLoop(
                cmd.action, cmd.params?.url, cmd.params?.selector
            );
            if (loopBlock) {
                result = { id: cmd.id, status: "blocked", error: loopBlock, blocked_reason: "loop_detected" };
                ws.sendResult(result);
                this.audit.log(cmd, result);
                return;
            }

            // Dispatch to handler
            switch (cmd.action) {
                case "navigate":   result = await this.navigate(cmd); break;
                case "extract":    result = await this.extract(cmd); break;
                case "screenshot": result = await this.screenshot(cmd); break;
                case "click":      result = await this.click(cmd); break;
                case "type":       result = await this.type(cmd); break;
                case "scroll":     result = await this.scroll(cmd); break;
                case "tab_create": result = await this.tabCreate(cmd); break;
                case "tab_list":   result = await this.tabList(cmd); break;
                case "tab_close":  result = await this.tabClose(cmd); break;
                case "tab_focus":  result = await this.tabFocus(cmd); break;
                case "ping":       result = { id: cmd.id, status: "ok", data: { pong: true } }; break;
                case "kill":
                    result = { id: cmd.id, status: "ok" };
                    ws.sendResult(result);
                    ws.onKill();
                    return;
                default:
                    result = { id: cmd.id, status: "error", error: `unknown action: ${cmd.action}` };
            }
        } catch (err) {
            result = { id: cmd.id, status: "error", error: err.message };
        }

        ws.sendResult(result);
        this.audit.log(cmd, result, Date.now() - startTime);
    }

    async navigate(cmd) {
        const { url, tabId } = cmd.params || {};

        // Payment URL check (layer 1)
        const paymentBlock = this.security.checkPaymentURL(url);
        if (paymentBlock) {
            return { id: cmd.id, status: "blocked", error: paymentBlock, blocked_reason: "payment_detected" };
        }

        let targetId = tabId;
        if (!targetId) {
            // Create new tab in group
            targetId = await this.tabs.createTab(url);
            return { id: cmd.id, status: "ok", data: { tabId: targetId, url } };
        }

        if (!this.tabs.isOwned(targetId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }

        const client = this.cdp.targets.get(targetId);
        if (!client) {
            return { id: cmd.id, status: "error", error: "CDP not attached to tab" };
        }

        await client.Page.navigate({ url });
        await client.Page.loadEventFired();

        // Post-navigate payment check on final URL
        const { result: evalResult } = await client.Runtime.evaluate({
            expression: "window.location.href"
        });
        const finalUrl = evalResult.value;
        const postNavBlock = this.security.checkPaymentURL(finalUrl);
        if (postNavBlock) {
            const tabInfo = this.tabs.getTabInfo(targetId);
            if (tabInfo && tabInfo.type === "helper-created") {
                await this.tabs.closeHelperTabs();
            } else {
                this.tabs.freezeTab(targetId);
            }
            return { id: cmd.id, status: "blocked", error: postNavBlock, blocked_reason: "payment_detected" };
        }

        const { result: titleResult } = await client.Runtime.evaluate({
            expression: "document.title"
        });

        return { id: cmd.id, status: "ok", data: { tabId: targetId, url: finalUrl, title: titleResult.value } };
    }

    async extract(cmd) {
        const { tabId, selector } = cmd.params || {};
        if (!this.tabs.isOwned(tabId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }

        const client = this.cdp.targets.get(tabId);
        if (!client) {
            return { id: cmd.id, status: "error", error: "CDP not attached" };
        }

        // DOM payment check (layer 2) before extraction
        const { result: domCheck } = await client.Runtime.evaluate({
            expression: this.security.getDOMCheckScript(),
            returnByValue: true,
        });
        if (domCheck.value && domCheck.value.blocked) {
            return { id: cmd.id, status: "blocked", error: domCheck.value.reason, blocked_reason: "payment_detected" };
        }

        let expression;
        if (selector) {
            expression = `document.querySelector('${selector.replace(/'/g, "\\'")}')?.innerText || ''`;
        } else {
            expression = `document.body?.innerText?.substring(0, 50000) || ''`;
        }

        const { result: extractResult } = await client.Runtime.evaluate({ expression });

        const { result: urlResult } = await client.Runtime.evaluate({ expression: "window.location.href" });
        const { result: titleResult } = await client.Runtime.evaluate({ expression: "document.title" });

        return {
            id: cmd.id,
            status: "ok",
            data: { content: extractResult.value, url: urlResult.value, title: titleResult.value },
        };
    }

    async screenshot(cmd) {
        const { tabId } = cmd.params || {};
        if (!this.tabs.isOwned(tabId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }
        const client = this.cdp.targets.get(tabId);
        if (!client) {
            return { id: cmd.id, status: "error", error: "CDP not attached" };
        }
        const { data } = await client.Page.captureScreenshot({ format: "png" });

        const { result: urlResult } = await client.Runtime.evaluate({ expression: "window.location.href" });
        const { result: titleResult } = await client.Runtime.evaluate({ expression: "document.title" });

        return {
            id: cmd.id,
            status: "ok",
            data: { screenshot: data, url: urlResult.value, title: titleResult.value },
        };
    }

    async click(cmd) {
        const { tabId, selector, text } = cmd.params || {};
        if (!this.tabs.isOwned(tabId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }

        // Action context payment check (layer 3)
        const contextBlock = this.security.checkActionContext("click", cmd.params, "");
        if (contextBlock) {
            return { id: cmd.id, status: "blocked", error: contextBlock, blocked_reason: "payment_detected" };
        }

        const client = this.cdp.targets.get(tabId);
        if (!client) {
            return { id: cmd.id, status: "error", error: "CDP not attached" };
        }

        const clickSelector = selector || (text ? `text=${text}` : null);
        if (!clickSelector) {
            return { id: cmd.id, status: "error", error: "selector or text required" };
        }

        // Find element coordinates via CDP
        const jsSelector = selector ? selector.replace(/'/g, "\\'") : null;
        let findExpr;
        if (jsSelector) {
            findExpr = `(function() {
                var el = document.querySelector('${jsSelector}');
                if (!el) return null;
                var rect = el.getBoundingClientRect();
                return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            })()`;
        } else {
            // text-based search
            findExpr = `(function() {
                var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    if (walker.currentNode.textContent.trim().includes('${(text || "").replace(/'/g, "\\'")}')) {
                        var el = walker.currentNode.parentElement;
                        var rect = el.getBoundingClientRect();
                        return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
                    }
                }
                return null;
            })()`;
        }

        const { result } = await client.Runtime.evaluate({
            expression: findExpr,
            returnByValue: true,
        });

        if (!result.value) {
            return { id: cmd.id, status: "error", error: `Element not found: ${clickSelector}` };
        }

        const { x, y } = result.value;
        await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

        const { result: urlResult } = await client.Runtime.evaluate({ expression: "window.location.href" });
        const { result: titleResult } = await client.Runtime.evaluate({ expression: "document.title" });

        return { id: cmd.id, status: "ok", data: { clicked: clickSelector, url: urlResult.value, title: titleResult.value } };
    }

    async type(cmd) {
        const { tabId, selector, text } = cmd.params || {};
        if (!this.tabs.isOwned(tabId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }

        // Action context payment check (layer 3)
        const contextBlock = this.security.checkActionContext("type", cmd.params, "");
        if (contextBlock) {
            return { id: cmd.id, status: "blocked", error: contextBlock, blocked_reason: "payment_detected" };
        }

        const client = this.cdp.targets.get(tabId);
        if (!client) {
            return { id: cmd.id, status: "error", error: "CDP not attached" };
        }

        // Focus the element
        const jsSelector = selector.replace(/'/g, "\\'");
        await client.Runtime.evaluate({
            expression: `document.querySelector('${jsSelector}')?.focus()`
        });

        // Type character by character via CDP Input
        for (const char of text) {
            await client.Input.dispatchKeyEvent({ type: "keyDown", text: char });
            await client.Input.dispatchKeyEvent({ type: "keyUp", text: char });
        }

        const { result: urlResult } = await client.Runtime.evaluate({ expression: "window.location.href" });

        return { id: cmd.id, status: "ok", data: { typed: text.length + " chars", url: urlResult.value } };
    }

    async scroll(cmd) {
        const { tabId, direction, amount } = cmd.params || {};
        if (!this.tabs.isOwned(tabId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }
        const client = this.cdp.targets.get(tabId);
        if (!client) {
            return { id: cmd.id, status: "error", error: "CDP not attached" };
        }

        const deltaX = direction === "left" ? -(amount || 300) : direction === "right" ? (amount || 300) : 0;
        const deltaY = direction === "up" ? -(amount || 300) : direction === "down" ? (amount || 300) : 0;

        await client.Input.dispatchMouseEvent({
            type: "mouseWheel", x: 400, y: 400, deltaX, deltaY,
        });

        return { id: cmd.id, status: "ok", data: { scrolled: direction } };
    }

    async tabCreate(cmd) {
        const { url } = cmd.params || {};
        const targetId = await this.tabs.createTab(url || "about:blank");
        return { id: cmd.id, status: "ok", data: { tabId: targetId } };
    }

    async tabList(cmd) {
        const tabs = await this.tabs.listTabs();
        return { id: cmd.id, status: "ok", data: { tabs } };
    }

    async tabClose(cmd) {
        const { tabId } = cmd.params || {};
        if (!this.tabs.isOwned(tabId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }
        this.tabs.revokeTab(tabId);
        return { id: cmd.id, status: "ok" };
    }

    async tabFocus(cmd) {
        const { tabId } = cmd.params || {};
        if (!this.tabs.isOwned(tabId)) {
            return { id: cmd.id, status: "blocked", error: "Tab khong thuoc AHVclaw", blocked_reason: "not_owned" };
        }
        const client = this.cdp.targets.get(tabId);
        if (client) {
            await client.Page.bringToFront();
        }
        return { id: cmd.id, status: "ok" };
    }
}

module.exports = CommandExecutor;
