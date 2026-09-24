import { existsSync } from 'node:fs';
import dns from 'node:dns/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config } from './config.js';

/**
 * A headless browser for agents that Tasks runs, so QA and product checks can use what they test. One
 * Chromium process, one isolated context per run (closed when the run ends), a few sessions at a time.
 *
 * All browser traffic goes through a small proxy in this process that resolves each host itself and refuses
 * private, loopback and link-local addresses, so an agent can't reach Tasks' own network. The browser only
 * sees the public internet; staging sites must be public (restrict them at the hosting level if needed).
 */

const CANDIDATES = [
  config.browser.path,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const executable = () => CANDIDATES.find((p) => existsSync(p)) ?? null;
export const browserAvailable = () => !!executable();

// ---------- only the public internet ----------

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) return isPrivateAddress(v.slice(7));
  // ::, ::1, v4-mapped/compatible, NAT64, unique-local, link-local, multicast
  return v.startsWith('::') || v.startsWith('64:ff9b:') || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

/** The address to connect to for a host, or an error when it (or any of its addresses) is private. */
async function allowedAddress(host: string) {
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true, verbatim: true });
  if (!addrs.length) throw new Error(`${host} doesn’t resolve`);
  const loopback = (ip: string) => /^127\./.test(ip) || ip === '::1';
  if (addrs.some((a) => isPrivateAddress(a.address) && !(config.browser.allowLoopback && loopback(a.address)))) {
    throw new Error(`${host} is a private address; the browser only reaches the public internet`);
  }
  return addrs[0].address;
}

function startProxy(): Promise<number> {
  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    allowedAddress(url.hostname).then(
      (ip) => {
        const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
        delete headers['proxy-connection'];
        const up = http.request({ host: ip, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers, setHost: false }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
        req.pipe(up);
      },
      (e) => res.writeHead(403, { 'content-type': 'text/plain' }).end((e as Error).message),
    );
  });
  // HTTPS and WebSockets arrive as CONNECT host:port.
  server.on('connect', (req, socket, head) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '');
    if (!m) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.on('error', () => {});
    allowedAddress(m[1]).then(
      (ip) => {
        const up = net.connect(Number(m[2]), ip, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) up.write(head);
          up.pipe(socket);
          socket.pipe(up);
        });
        up.on('error', () => socket.destroy());
        socket.on('close', () => up.destroy());
      },
      () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'),
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

// ---------- the browser and per-run sessions ----------

type Session = { context: BrowserContext; page: Page; logs: string[] };

let proxyPort: Promise<number> | null = null;
let browser: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const sessions = new Map<string, Promise<Session>>();
let open = 0;
let waiting: (() => void)[] = [];

function getBrowser() {
  if (!browser) {
    const exe = executable();
    if (!exe) throw new Error('There’s no browser installed on this Tasks server');
    browser = (async () => {
      const port = await (proxyPort ??= startProxy());
      const b = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: [
          `--proxy-server=http://127.0.0.1:${port}`,
          '--proxy-bypass-list=<-loopback>', // loopback goes through the proxy too
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--mute-audio',
        ],
      });
      b.on('disconnected', () => (browser = null));
      return b;
    })();
    browser.catch(() => (browser = null));
  }
  return browser;
}

function acquire(): Promise<void> {
  if (open < config.browser.maxSessions) {
    open++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const go = () => {
      clearTimeout(timer);
      open++;
      resolve();
    };
    const timer = setTimeout(() => {
      waiting = waiting.filter((w) => w !== go);
      reject(new Error('All browser sessions are busy; try again in a minute'));
    }, 120_000);
    waiting.push(go);
  });
}

function release() {
  open--;
  waiting.shift()?.();
  if (!open && !waiting.length) {
    if (idleTimer) clearTimeout(idleTimer);
    // Free the Pi's memory when nobody has browsed for a while.
    idleTimer = setTimeout(() => {
      if (!open) void browser?.then((b) => b.close()).catch(() => {});
    }, 5 * 60_000);
  }
}

const log = (logs: string[], line: string) => {
  logs.push(line.slice(0, 500));
  if (logs.length > 200) logs.shift();
};

function session(runId: string): Promise<Session> {
  let s = sessions.get(runId);
  if (!s) {
    s = (async () => {
      await acquire();
      try {
        if (idleTimer) clearTimeout(idleTimer);
        const context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const logs: string[] = [];
        page.setDefaultTimeout(15_000);
        page.on('console', (m) => log(logs, `console.${m.type()}: ${m.text()}`));
        page.on('pageerror', (e) => log(logs, `uncaught error: ${e.message}`));
        page.on('requestfailed', (r) => log(logs, `failed to load ${r.url()}: ${r.failure()?.errorText ?? ''}`));
        page.on('response', (r) => r.status() >= 400 && log(logs, `HTTP ${r.status()} for ${r.url()}`));
        page.on('dialog', (d) => {
          log(logs, `${d.type()} dialog: ${d.message()} (accepted)`);
          void d.accept().catch(() => {});
        });
        // Keep one tab: popups are logged and closed.
        context.on('page', (p) => {
          if (p === page) return;
          log(logs, `a popup opened ${p.url()} (closed; open it with browser_open if needed)`);
          void p.close().catch(() => {});
        });
        return { context, page, logs };
      } catch (e) {
        release();
        throw e;
      }
    })();
    sessions.set(runId, s);
    s.catch(() => sessions.delete(runId));
  }
  return s;
}

export async function closeSession(runId: string) {
  const s = sessions.get(runId);
  if (!s) return;
  sessions.delete(runId);
  let ok: Session;
  try {
    ok = await s;
  } catch {
    return; // never opened; its slot was released
  }
  await ok.context.close().catch(() => {});
  release();
}

// ---------- what an agent can do ----------

const TEXT_LIMIT = 12_000;

/**
 * What's on the page, as Playwright's AI snapshot: the accessibility tree in text, each element tagged with a
 * ref like [ref=e7] that the other actions take (the same format Playwright MCP gives agents). No vision needed.
 */
async function snapshot(page: Page) {
  let tree = await page.ariaSnapshot({ mode: 'ai', boxes: true, timeout: 10_000 }).catch((e) => `(couldn’t read the page: ${(e as Error).message})`);
  if (tree.length > TEXT_LIMIT) tree = `${tree.slice(0, TEXT_LIMIT)}\n… (truncated; use browser_eval to read specific parts)`;
  return { url: page.url(), title: await page.title().catch(() => ''), page: tree };
}

const target = (page: Page, t: string) => page.locator(/^e\d+$/.test(t) ? `aria-ref=${t}` : t).first();
/**
 * Act on an element: normally first, then once more scrolled into view and forced (a sticky header or an
 * animation can cover it). If that fails too, say what to do rather than just "timeout".
 */
async function onElement(page: Page, t: string, act: (loc: ReturnType<typeof target>, force: boolean) => Promise<void>) {
  const loc = target(page, t);
  try {
    await act(loc, false);
  } catch {
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2_000 });
      await act(loc, true);
    } catch {
      throw new Error(
        `Couldn't reach ${t}: it may be covered, moving, or gone (refs change whenever the page updates). Read the page again for fresh refs, or click by x/y (e.g. inside a canvas).`,
      );
    }
  }
}

const settle = (page: Page) => page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {}).then(() => page.waitForTimeout(300));

export const browser_ = {
  async open(runId: string, url: string) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs');
    const { page } = await session(runId);
    const res = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(300);
    return { status: res?.status() ?? null, ...(await snapshot(page)) };
  },
  async read(runId: string) {
    return snapshot((await session(runId)).page);
  },
  async click(runId: string, a: { target?: string; x?: number; y?: number }) {
    const { page } = await session(runId);
    if (a.target) await onElement(page, a.target, (loc, force) => loc.click({ timeout: force ? 3_000 : 5_000, force }));
    else if (a.x !== undefined && a.y !== undefined) await page.mouse.click(a.x, a.y);
    else throw new Error('Give a target (an element ref like e3, or a CSS/text selector) or x and y');
    await settle(page);
    return snapshot(page);
  },
  async type(runId: string, a: { target?: string; text: string; submit?: boolean }) {
    const { page } = await session(runId);
    if (a.target) await onElement(page, a.target, (loc, force) => loc.fill(a.text, { timeout: force ? 3_000 : 5_000, force }));
    else await page.keyboard.type(a.text);
    if (a.submit) await page.keyboard.press('Enter');
    await settle(page);
    return snapshot(page);
  },
  async press(runId: string, a: { key: string; times?: number; hold_ms?: number }) {
    const { page } = await session(runId);
    for (let i = 0; i < Math.min(a.times ?? 1, 50); i++) {
      if (a.hold_ms) {
        await page.keyboard.down(a.key);
        await page.waitForTimeout(Math.min(a.hold_ms, 5_000));
        await page.keyboard.up(a.key);
      } else await page.keyboard.press(a.key);
    }
    await page.waitForTimeout(200);
    return { ok: true, url: page.url() };
  },
  async wait(runId: string, ms: number) {
    const { page } = await session(runId);
    await page.waitForTimeout(Math.max(0, Math.min(ms, 10_000)));
    return { ok: true };
  },
  async screenshot(runId: string, fullPage?: boolean) {
    const { page } = await session(runId);
    const image = (await page.screenshot({ type: 'jpeg', quality: 60, fullPage: !!fullPage })).toString('base64');
    return { url: page.url(), title: await page.title(), image };
  },
  async console(runId: string) {
    const { logs } = await session(runId);
    const out = logs.splice(0);
    return { messages: out.length ? out : ['(nothing since the last check)'] };
  },
  async evaluate(runId: string, expression: string) {
    const { page } = await session(runId);
    const value = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      const v = (0, eval)(src);
      return Promise.resolve(v).then((x) => {
        try {
          return JSON.parse(JSON.stringify(x ?? null));
        } catch {
          return String(x);
        }
      });
    }, expression);
    return { value };
  },
};
