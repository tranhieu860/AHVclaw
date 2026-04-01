const { chromium } = require('playwright');
const http = require('http');

let browser = null;
let contexts = new Map(); // userId -> { context, page }

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('Browser launched');
  }
  return browser;
}

async function getPage(userId) {
  if (!contexts.has(userId)) {
    const b = await getBrowser();
    const context = await b.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'AHVclaw Browser/1.0'
    });
    const page = await context.newPage();
    contexts.set(userId, { context, page });
    console.log('New context for user ' + userId);
  }
  return contexts.get(userId).page;
}

async function closePage(userId) {
  if (contexts.has(userId)) {
    const { context } = contexts.get(userId);
    await context.close();
    contexts.delete(userId);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { action, userId, url, selector, text, key } = data;

      let result = {};

      switch (action) {
        case 'navigate': {
          const page = await getPage(userId);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          result = { url: page.url(), title: await page.title() };
          break;
        }

        case 'screenshot': {
          const page = await getPage(userId);
          const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
          result = { image: buffer.toString('base64'), url: page.url(), title: await page.title() };
          break;
        }

        case 'click': {
          const page = await getPage(userId);
          await page.click(selector, { timeout: 5000 });
          await page.waitForTimeout(1000);
          result = { clicked: selector, url: page.url() };
          break;
        }

        case 'type': {
          const page = await getPage(userId);
          await page.fill(selector, text);
          result = { typed: text, selector };
          break;
        }

        case 'press': {
          const page = await getPage(userId);
          await page.keyboard.press(key);
          result = { pressed: key };
          break;
        }

        case 'extract': {
          const page = await getPage(userId);
          const content = await page.evaluate(() => {
            const body = document.body;
            const text = body.innerText || body.textContent || '';
            return text.substring(0, 50000);
          });
          result = { content, url: page.url(), title: await page.title() };
          break;
        }

        case 'evaluate': {
          const page = await getPage(userId);
          const evalResult = await page.evaluate(data.script);
          result = { result: JSON.stringify(evalResult) };
          break;
        }

        case 'close': {
          await closePage(userId);
          result = { closed: true };
          break;
        }

        case 'status': {
          const hasPage = contexts.has(userId);
          if (hasPage) {
            const page = contexts.get(userId).page;
            result = { active: true, url: page.url(), title: await page.title() };
          } else {
            result = { active: false };
          }
          break;
        }

        default:
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Unknown action: ' + action }));
          return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

const PORT = 3102;
server.listen(PORT, '127.0.0.1', () => {
  console.log('Playwright server listening on port ' + PORT);
});

process.on('SIGTERM', async () => {
  for (const [userId] of contexts) {
    await closePage(userId);
  }
  if (browser) await browser.close();
  process.exit(0);
});
