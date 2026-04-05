// AHVclaw Content Script
// Executes DOM actions dispatched from background.js

(function() {
  // Prevent double-injection
  if (window.__ahvclaw_content_loaded) return;
  window.__ahvclaw_content_loaded = true;

  // --- Message listener ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action, params } = message;

    (async () => {
      try {
        let result;
        switch (action) {
          case "click":
            result = await handleClick(params);
            break;
          case "type":
            result = await handleType(params);
            break;
          case "scroll":
            result = await handleScroll(params);
            break;
          case "read_page":
            result = handleReadPage(params);
            break;
          default:
            result = { success: false, error: `Unknown action: ${action}` };
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // keep channel open for async response
  });

  // --- Find Element ---
  function findElement(selector, text) {
    // Try CSS selector first
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (e) { /* invalid selector, fall through */ }
    }

    // Search by visible text
    if (text) {
      const searchText = text.toLowerCase().trim();
      const candidates = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"], [onclick]');
      for (const el of candidates) {
        const elText = (el.textContent || el.value || el.getAttribute("aria-label") || "").toLowerCase().trim();
        if (elText === searchText || elText.includes(searchText)) {
          return el;
        }
      }
      // Broader search: any element containing text
      const allElements = document.querySelectorAll("*");
      for (const el of allElements) {
        if (el.children.length === 0 || el.tagName === "A" || el.tagName === "BUTTON") {
          const elText = (el.textContent || "").toLowerCase().trim();
          if (elText === searchText) return el;
        }
      }
    }

    return null;
  }

  // --- Visual Feedback ---
  function highlightElement(el) {
    if (!el || !el.style) return;
    const prev = el.style.outline;
    el.style.outline = "3px solid #2962FF";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prev;
      el.style.outlineOffset = "";
    }, 1500);
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      background: "rgba(41, 98, 255, 0.9)",
      color: "white",
      padding: "10px 18px",
      borderRadius: "8px",
      fontSize: "13px",
      fontFamily: "system-ui, sans-serif",
      zIndex: "2147483647",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      transition: "opacity 0.3s",
      opacity: "1"
    });
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // --- Click ---
  async function handleClick(params) {
    const el = findElement(params.selector, params.text);
    if (!el) return { success: false, error: `Element not found: ${params.selector || params.text}` };

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(300);
    highlightElement(el);

    // Simulate realistic click
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    el.click();

    showToast(`AHVclaw: clicked "${params.text || params.selector}"`);
    return { success: true, data: { tag: el.tagName, text: (el.textContent || "").substring(0, 100) } };
  }

  // --- Type ---
  async function handleType(params) {
    let el;
    if (params.selector || params.text) {
      el = findElement(params.selector, params.text);
    }
    // If no element found, try the active element
    if (!el) {
      el = document.activeElement;
    }
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && !el.isContentEditable)) {
      return { success: false, error: "No suitable input element found" };
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    highlightElement(el);
    el.focus();

    // Clear existing value if requested
    if (params.clear) {
      if (el.isContentEditable) {
        el.textContent = "";
      } else {
        el.value = "";
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Type character by character
    const value = params.value || params.text || "";
    for (const char of value) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      if (el.isContentEditable) {
        el.textContent += char;
      } else {
        el.value += char;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await sleep(30 + Math.random() * 40);
    }

    // Press Enter if requested
    if (params.pressEnter) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      if (el.form) el.form.submit();
    }

    showToast(`AHVclaw: typed "${value.substring(0, 30)}..."`);
    return { success: true, data: { typed: value.length + " chars" } };
  }

  // --- Scroll ---
  async function handleScroll(params) {
    const direction = params.direction || "down";
    const amount = params.amount || 500;
    let dx = 0, dy = 0;

    switch (direction) {
      case "down":  dy = amount;  break;
      case "up":    dy = -amount; break;
      case "left":  dx = -amount; break;
      case "right": dx = amount;  break;
    }

    window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
    await sleep(500);

    return {
      success: true,
      data: {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        pageHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight
      }
    };
  }

  // --- Read Page ---
  function handleReadPage(params) {
    const data = {
      title: document.title,
      url: window.location.href,
      headings: [],
      links: [],
      forms: [],
      buttons: [],
      bodyText: ""
    };

    // Headings
    document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(h => {
      data.headings.push({ level: h.tagName, text: h.textContent.trim().substring(0, 200) });
    });

    // Links (first 50)
    const links = document.querySelectorAll("a[href]");
    for (let i = 0; i < Math.min(links.length, 50); i++) {
      const a = links[i];
      data.links.push({ text: a.textContent.trim().substring(0, 100), href: a.href });
    }

    // Form fields
    document.querySelectorAll("input, textarea, select").forEach(el => {
      data.forms.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        name: el.name || "",
        id: el.id || "",
        placeholder: el.placeholder || "",
        value: el.type === "password" ? "***" : (el.value || "").substring(0, 100)
      });
    });

    // Buttons
    document.querySelectorAll("button, input[type='submit'], input[type='button'], [role='button']").forEach(el => {
      data.buttons.push({
        text: (el.textContent || el.value || "").trim().substring(0, 100),
        id: el.id || "",
        class: el.className ? el.className.toString().substring(0, 100) : ""
      });
    });

    // Body text (truncated)
    const textContent = document.body ? document.body.innerText : "";
    data.bodyText = textContent.substring(0, 5000);

    return { success: true, data };
  }

  // --- Utility ---
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
