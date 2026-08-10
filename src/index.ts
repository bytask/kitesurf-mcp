import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { z } from "zod";

export interface Env {
  BROWSER: Fetcher;
  MCP_OBJECT: DurableObjectNamespace;
  MCP_PATH_SECRET: string;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const GOTO_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_CHARS = 15_000;

type WaitMode = "load" | "domcontentloaded" | "networkidle";

const waitUntilOf = (wait: WaitMode) =>
  wait === "networkidle" ? ("networkidle2" as const) : wait;

const urlParam = z.string().url().describe("Absolute URL to open (https://...)");
const waitParam = z
  .enum(["load", "domcontentloaded", "networkidle"])
  .optional()
  .describe("When to consider navigation finished (default: load)");

async function launchKitesurf(env: Env): Promise<Browser> {
  // Beta quirk: Kitesurf occasionally returns "error code: 1042"; one retry clears it
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await puppeteer.launch(env.BROWSER, { browser: "kitesurf" });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function withPage<T>(
  env: Env,
  url: string,
  wait: WaitMode,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const browser = await launchKitesurf(env);
  try {
    const page = await browser.newPage();
    await page.setViewport(DEFAULT_VIEWPORT);
    await page.goto(url, { waitUntil: waitUntilOf(wait), timeout: GOTO_TIMEOUT_MS });
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function pageText(page: Page, maxChars: number) {
  // Read url/title from inside the page: puppeteer's target-level view can go
  // stale after DOM-driven navigation on Kitesurf
  const info = (await page.evaluate(
    "({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' })"
  )) as { url: string; title: string; text: string };
  const truncated = info.text.length > maxChars;
  return {
    final_url: info.url,
    title: info.title,
    text: truncated
      ? `${info.text.slice(0, maxChars)}\n\n[... truncated at ${maxChars} chars]`
      : info.text,
  };
}

const textResult = (data: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
});

const errorResult = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

// Kitesurf's CDP surface doesn't reliably support puppeteer's waitForSelector /
// Input-domain events, so interactions run at the DOM level via evaluate().
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForSel(p: Page, sel: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await p.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) as boolean) return;
    } catch {
      // page mid-navigation; retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for selector: ${sel}`);
}

async function settle(p: Page, ms = 5000) {
  const deadline = Date.now() + ms;
  await sleep(300);
  while (Date.now() < deadline) {
    try {
      if (((await p.evaluate("document.readyState")) as string) === "complete") return;
    } catch {
      // navigating
    }
    await sleep(250);
  }
}

const withEl = (sel: string, body: string) =>
  `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error(${JSON.stringify(`No element matches selector: ${sel}`)}); ${body} })()`;

// Kitesurf quirk: DOM-driven navigation (link click, form submit) updates
// `location` but never swaps the document. Watch for the location change inside
// the page, then replay it as a real page.goto() from outside.
// Kitesurf also no-ops form submission (requestSubmit/submit fire no navigation),
// so when nothing moved, formFallback may synthesize the GET submission URL.
const navWatchScript = (setup: string, action: string, formFallback = "return null;") => `(async () => {
  ${setup}
  const before = location.href;
  ${action}
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (location.href !== before) break;
  }
  let after = location.href;
  if (after === before) {
    const fb = (() => { try { ${formFallback} } catch (e) { return null; } })();
    if (fb) after = fb;
  }
  return { before, after };
})()`;

const buildFormUrl = `
  const fd = new FormData(form);
  if (submitter && submitter.name) fd.append(submitter.name, submitter.value || '');
  const qs = new URLSearchParams(fd).toString();
  const base = form.action || location.href;
  return qs ? base + (base.includes('?') ? '&' : '?') + qs : base;
`;

type NavWatch = { before: string; after: string } | undefined;

// Best-effort: cap the watch in case the context is torn down mid-action
const evalWithCap = (p: Page, script: string) =>
  Promise.race([p.evaluate(script), sleep(12_000)]) as Promise<NavWatch>;

async function followNav(p: Page, nav: NavWatch) {
  if (nav && nav.after && nav.after !== nav.before) {
    await p.goto(nav.after, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS }).catch(() => {});
  } else {
    await settle(p);
  }
}

const domClick = (p: Page, sel: string) =>
  evalWithCap(
    p,
    navWatchScript(
      `const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error(${JSON.stringify(`No element matches selector: ${sel}`)});`,
      "el.click();",
      `const isSubmit = el.form && ((el.tagName === 'INPUT' && el.type === 'submit') || (el.tagName === 'BUTTON' && el.type === 'submit'));
       if (!isSubmit) { const a = el.closest && el.closest('a[href]'); if (a && a.href) return a.href; return null; }
       const form = el.form; const submitter = el;
       ${buildFormUrl}`
    )
  );

const domFill = (p: Page, sel: string, value: string) =>
  p.evaluate(
    withEl(
      sel,
      `if (el.focus) el.focus();
       const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       const setter = Object.getOwnPropertyDescriptor(proto, 'value');
       if (setter && setter.set && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) setter.set.call(el, ${JSON.stringify(value)});
       else if ('value' in el) el.value = ${JSON.stringify(value)};
       else el.textContent = ${JSON.stringify(value)};
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));`
    )
  );

const domSelect = (p: Page, sel: string, value: string) =>
  p.evaluate(
    withEl(
      sel,
      `el.value = ${JSON.stringify(value)};
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));`
    )
  );

const domPress = (p: Page, key: string) =>
  evalWithCap(
    p,
    navWatchScript(
      "const el = document.activeElement || document.body;",
      `el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
       el.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, bubbles: true }));
       if (${JSON.stringify(key)} === 'Enter' && el.closest) {
         const form = el.closest('form');
         if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
       }`,
      `if (${JSON.stringify(key)} !== 'Enter' || !el.closest) return null;
       const form = el.closest('form'); if (!form) return null;
       const submitter = null;
       ${buildFormUrl}`
    )
  );

const actionSchema = z.object({
  type: z
    .enum(["click", "fill", "select", "press", "wait_for", "wait_ms", "goto"])
    .describe(
      "click: click selector / fill: type value into selector / select: choose value in <select> / press: press a key (value, e.g. Enter) / wait_for: wait until selector appears / wait_ms: pause value milliseconds / goto: navigate to value as URL"
    ),
  selector: z.string().optional().describe("CSS selector (for click, fill, select, wait_for)"),
  value: z.string().optional().describe("Value (for fill, select, press, wait_ms, goto)"),
});

export class KitesurfMCP extends McpAgent<Env> {
  server = new McpServer({ name: "kitesurf", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "fetch_page",
      {
        description:
          "Open a URL in Kitesurf (Cloudflare's agent browser), render it, and return the page's visible text. Fast disposable session per call. Use this as the default way to read a web page.",
        inputSchema: {
          url: urlParam,
          wait: waitParam,
          max_chars: z.number().int().min(500).max(60_000).optional()
            .describe(`Max characters of text to return (default ${DEFAULT_MAX_CHARS})`),
        },
      },
      async ({ url, wait, max_chars }) => {
        try {
          return textResult(
            await withPage(this.env, url, wait ?? "load", (p) =>
              pageText(p, max_chars ?? DEFAULT_MAX_CHARS)
            )
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    this.server.registerTool(
      "get_html",
      {
        description:
          "Open a URL and return rendered HTML. Optionally scope to a CSS selector (outerHTML of first match).",
        inputSchema: {
          url: urlParam,
          selector: z.string().optional().describe("CSS selector to scope the HTML to"),
          wait: waitParam,
          max_chars: z.number().int().min(500).max(120_000).optional()
            .describe("Max characters of HTML to return (default 50000)"),
        },
      },
      async ({ url, selector, wait, max_chars }) => {
        try {
          const limit = max_chars ?? 50_000;
          const html = await withPage(this.env, url, wait ?? "load", async (p) => {
            if (selector) {
              const outer = (await p.evaluate(
                `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null; })()`
              )) as string | null;
              return outer ?? `No element matches selector: ${selector}`;
            }
            return await p.content();
          });
          return textResult(
            html.length > limit ? `${html.slice(0, limit)}\n<!-- truncated at ${limit} chars -->` : html
          );
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    this.server.registerTool(
      "screenshot",
      {
        description:
          "Open a URL and return a screenshot image. Default 1280x800 JPEG; use full_page for the entire scroll height.",
        inputSchema: {
          url: urlParam,
          full_page: z.boolean().optional().describe("Capture full scroll height (default false)"),
          width: z.number().int().min(320).max(1920).optional().describe("Viewport width (default 1280)"),
          height: z.number().int().min(240).max(1920).optional().describe("Viewport height (default 800)"),
          format: z.enum(["jpeg", "png"]).optional().describe("Image format (default jpeg)"),
          wait: waitParam,
        },
      },
      async ({ url, full_page, width, height, format, wait }) => {
        try {
          const fmt = format ?? "jpeg";
          const data = await withPage(this.env, url, wait ?? "load", async (p) => {
            await p.setViewport({ width: width ?? 1280, height: height ?? 800 });
            return (await p.screenshot({
              fullPage: full_page ?? false,
              type: fmt,
              ...(fmt === "jpeg" ? { quality: 80 } : {}),
              encoding: "base64",
            })) as unknown as string;
          });
          return {
            content: [
              { type: "image" as const, data, mimeType: fmt === "jpeg" ? "image/jpeg" : "image/png" },
            ],
          };
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    this.server.registerTool(
      "extract_links",
      {
        description: "Open a URL and return all links on the page as {text, href} pairs.",
        inputSchema: { url: urlParam, wait: waitParam },
      },
      async ({ url, wait }) => {
        try {
          const links = await withPage(this.env, url, wait ?? "load", async (p) =>
            (await p.evaluate(
              `Array.from(document.querySelectorAll('a[href]'))
                .map(a => ({ text: (a.innerText || '').trim().slice(0, 200), href: a.href }))
                .filter(l => l.href && !l.href.startsWith('javascript:'))
                .slice(0, 500)`
            )) as { text: string; href: string }[]
          );
          return textResult(links);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    this.server.registerTool(
      "evaluate",
      {
        description:
          "Open a URL and evaluate a JavaScript expression in the page context; returns the JSON-serialized result. Use an IIFE or a single expression (e.g. document.title, or (() => {...})()).",
        inputSchema: {
          url: urlParam,
          script: z.string().describe("JavaScript expression to evaluate in the page"),
          wait: waitParam,
        },
      },
      async ({ url, script, wait }) => {
        try {
          const result = await withPage(this.env, url, wait ?? "load", (p) => p.evaluate(script));
          return textResult(result === undefined ? "undefined" : result);
        } catch (err) {
          return errorResult(err);
        }
      }
    );

    this.server.registerTool(
      "interact",
      {
        description:
          "Open a URL, run a sequence of interactions (click / fill / select / press / wait_for / wait_ms / goto) in one disposable session, then return the resulting page's text. Use for form submission and multi-step flows. Notes: login sessions do not persist between calls; navigation from POST forms is replayed as GET, so prefer GET forms or direct URLs.",
        inputSchema: {
          url: urlParam,
          actions: z.array(actionSchema).min(1).max(25).describe("Interactions to run in order"),
          wait: waitParam,
          max_chars: z.number().int().min(500).max(60_000).optional()
            .describe(`Max characters of final page text (default ${DEFAULT_MAX_CHARS})`),
        },
      },
      async ({ url, actions, wait, max_chars }) => {
        try {
          const result = await withPage(this.env, url, wait ?? "load", async (p) => {
            for (const a of actions) {
              switch (a.type) {
                case "click":
                  if (!a.selector) throw new Error("click requires selector");
                  await waitForSel(p, a.selector, 8_000);
                  await followNav(p, await domClick(p, a.selector));
                  break;
                case "fill":
                  if (!a.selector) throw new Error("fill requires selector");
                  await waitForSel(p, a.selector, 8_000);
                  await domFill(p, a.selector, a.value ?? "");
                  break;
                case "select":
                  if (!a.selector) throw new Error("select requires selector");
                  await waitForSel(p, a.selector, 8_000);
                  await domSelect(p, a.selector, a.value ?? "");
                  break;
                case "press":
                  await followNav(p, await domPress(p, a.value ?? "Enter"));
                  break;
                case "wait_for":
                  if (!a.selector) throw new Error("wait_for requires selector");
                  await waitForSel(p, a.selector, 15_000);
                  break;
                case "wait_ms":
                  await sleep(Math.min(Number(a.value ?? 1000), 10_000));
                  break;
                case "goto":
                  if (!a.value) throw new Error("goto requires value (URL)");
                  await p.goto(a.value, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
                  break;
              }
            }
            return pageText(p, max_chars ?? DEFAULT_MAX_CHARS);
          });
          return textResult(result);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);
    const base = `/mcp-${env.MCP_PATH_SECRET}`;
    if (env.MCP_PATH_SECRET && (pathname === base || pathname.startsWith(`${base}/`))) {
      return KitesurfMCP.serve(base, { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
