// /opt/ahvclaw/helper/src/security.js
// Payment block (3 layers), rate limiter, loop detector.

const PAYMENT_URL_PATTERNS = [
    /\/checkout/i, /\/payment/i, /\/cart\/confirm/i, /\/order\//i,
    /\/pay\//i, /\/billing\//i, /\/purchase/i,
];

const PAYMENT_IFRAME_DOMAINS = [
    "stripe.com", "paypal.com", "braintree", "momo.vn", "vnpay.vn",
    "pay.google.com", "apple.com/apple-pay",
];

class Security {
    constructor() {
        this.actionCounts = new Map();  // minute bucket -> count
        this.actionHistory = [];         // {key, timestamp}
    }

    // Layer 1: URL pattern check
    checkPaymentURL(url) {
        if (!url) return null;
        for (const pattern of PAYMENT_URL_PATTERNS) {
            if (pattern.test(url)) {
                return `payment_url_match: ${pattern}`;
            }
        }
        return null;
    }

    // Layer 2: DOM semantic check script (run via CDP Runtime.evaluate)
    getDOMCheckScript() {
        return `
        (function() {
            var cardInputs = document.querySelectorAll(
                input[autocomplete*=cc-], input[name*=card], input[name*=cvv],  +
                input[name*=expir], input[inputmode=numeric][maxlength=16],  +
                input[inputmode=numeric][maxlength=19]
            );
            if (cardInputs.length > 0) return { blocked: true, reason: card_input_fields_detected };

            var iframes = document.querySelectorAll(iframe);
            var paymentDomains = ${JSON.stringify(PAYMENT_IFRAME_DOMAINS)};
            for (var i = 0; i < iframes.length; i++) {
                var src = iframes[i].src || ;
                for (var j = 0; j < paymentDomains.length; j++) {
                    if (src.indexOf(paymentDomains[j]) !== -1) return { blocked: true, reason: payment_iframe:  + paymentDomains[j] };
                }
            }

            if (cardInputs.length > 0) {
                var form = cardInputs[0].closest(form);
                if (form) {
                    var buttons = form.querySelectorAll(button[type=submit], input[type=submit], [role=button]);
                    if (buttons.length > 0) return { blocked: true, reason: submit_button_near_card_form };
                }
            }

            return { blocked: false };
        })()
        `;
    }

    // Layer 3: Action context check
    checkActionContext(action, params, pageUrl) {
        if (action === "click" && params) {
            const PAYMENT_BUTTON_TEXTS = [
                /place\s*order/i, /confirm\s*purchase/i, /pay\s*now/i,
                /complete\s*order/i, /submit\s*payment/i,
                /thanh\s*to[aá]n/i, /[đd][aặ]t\s*h[aà]ng/i, /x[aá]c\s*nh[aậ]n\s*mua/i,
            ];
            for (const pattern of PAYMENT_BUTTON_TEXTS) {
                if (pattern.test(params.text || "")) {
                    return `payment_button_text: ${params.text}`;
                }
            }
        }
        if (action === "type" && params && params.selector) {
            if (/autocomplete.*cc-/i.test(params.selector)) {
                return "typing_in_card_field";
            }
        }
        if (action === "navigate" && params) {
            return this.checkPaymentURL(params.url);
        }
        return null;
    }

    // Rate limiter: max 30 actions/minute
    checkRateLimit() {
        const now = Date.now();
        const minuteKey = Math.floor(now / 60000);

        // Clean old entries
        for (const [key] of this.actionCounts) {
            if (key < minuteKey - 1) this.actionCounts.delete(key);
        }

        const count = (this.actionCounts.get(minuteKey) || 0) + 1;
        this.actionCounts.set(minuteKey, count);

        if (count > 30) {
            return "rate_limit_exceeded: 30/min";
        }
        return null;
    }

    // Loop detector: sliding window 60s
    checkLoop(action, url, selector) {
        const now = Date.now();
        const key = `${action}:${url || ""}:${selector || ""}`;

        this.actionHistory.push({ key, timestamp: now });

        // Clean entries older than 60s
        this.actionHistory = this.actionHistory.filter(e => now - e.timestamp < 60000);

        const count = this.actionHistory.filter(e => e.key === key).length;

        if (action === "navigate" && count >= 2) {
            return `duplicate_navigate: ${url} x${count}`;
        }
        if (action === "click" && count >= 5) {
            return `repetitive_click: ${selector} x${count}`;
        }
        if (count >= 3) {
            return `loop_detected: ${action} x${count}`;
        }
        return null;
    }
}

module.exports = Security;
