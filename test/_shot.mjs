/**
 * 视觉快照：在宿主容器层级 + scoped 样式下渲染插件，导出图标/列表视图与亮暗主题截图。
 *
 * 用法: MS_HOST_REPO=D:/code/my-search-desktop node test/_shot.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = root;
const hostRepo = process.env.MS_HOST_REPO || path.join(root, "..", "my-search-desktop");
const { scopeCss } = await import(pathToFileURL(path.join(hostRepo, "src", "lib", "util.ts")).href);

/**
 * 抽取宿主 style.css 里的「插件共享主题变量」区块（html / html.theme-light /
 * html.theme-dark 三组 --token 定义）并在截图页里原样注入。
 *
 * 为什么必须抽真实的一段：插件的 CSS 写的是 `var(--text, 兜底)`，兜底值只在
 * **独立开发**（没有宿主变量）时才该生效。若截图时不注入宿主变量，就永远只
 * 能看到浅色兜底，暗色主题的真实观感完全测不到——那等于没测。
 */
function hostThemeCss() {
  const css = readFileSync(path.join(hostRepo, "src", "css", "style.css"), "utf8");
  // 从基准 html 块开始，收齐 html / html.theme-light / html.theme-dark 三块
  const start = css.indexOf("html {");
  if (start < 0) return "";
  const out = [];
  let i = start;
  // 依次抓取连续的 html / html.theme-* 规则块（每块以 "}" 结束）
  while (i < css.length) {
    const braceOpen = css.indexOf("{", i);
    if (braceOpen < 0) break;
    const header = css.slice(i, braceOpen).trim();
    if (!/^html(\.theme-(light|dark))?$/.test(header)) break;
    const close = css.indexOf("}", braceOpen);
    if (close < 0) break;
    out.push(css.slice(i, close + 1));
    i = close + 1;
    // 跳过空白
    while (i < css.length && /\s/.test(css[i])) i++;
  }
  return out.join("\n");
}
const themeCss = hostThemeCss();

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(pluginDir, u === "/" ? "/ui/detail.html" : u);
  try {
    let body = await readFile(file);
    const ext = path.extname(file);
    if (ext === ".html") {
      let html = String(body).replace(/<script\s+src=["']index\.js["']\s*>\s*<\/script>/i, "");
      const css = scopeCss(await readFile(path.join(pluginDir, "ui", "detail.css"), "utf8"), "#text_show .plugin-view");
      // 先注入宿主的主题变量（模拟真实搜索窗口），再注入 scoped 的插件样式
      html = html.replace("</head>", `<style>${themeCss}</style>\n<style>${css}</style></head>`);
      html = html.replace(/<body>/, '<body><div id="text_show"><div class="plugin-view"><div class="ms-plugin-session">');
      html = html.replace(/<\/body>/, "</div></div></div></body>");
      body = Buffer.from(html, "utf8");
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("nf"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const bin = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const chrome = spawn(bin, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--disable-gpu",
  `--user-data-dir=${path.join(root, "test", "_chrome-profile-shot")}`, "about:blank"]);
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d.toString(); const m = buf.match(/ws:\/\/[^\s]+/); if (m) res(m[0]); });
  setTimeout(() => rej(new Error("timeout")), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const S = (method, params = {}, sid) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: sid })); });

const { result: t } = await S("Target.getTargets");
const page = t.targetInfos.find((x) => x.type === "page");
const { result: at } = await S("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const sid = at.sessionId;
await S("Page.enable", {}, sid);
await S("Runtime.enable", {}, sid);
await S("Emulation.setDeviceMetricsOverride", { width: 640, height: 560, deviceScaleFactor: 2, mobile: false }, sid);

const js = readFileSync(path.join(pluginDir, "ui", "index.js"), "utf8");
await S("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__mem = {};
  window.__iconReply = {
    "C:\\\\demo\\\\报告.docx": "data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2b579a"/><text x="8" y="11" font-size="8" fill="#fff" text-anchor="middle" font-family="Arial">W</text></svg>').toString("base64")}",
    "C:\\\\demo\\\\演示.pptx": "data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#d24726"/><text x="8" y="11" font-size="8" fill="#fff" text-anchor="middle" font-family="Arial">P</text></svg>').toString("base64")}",
    "C:\\\\demo\\\\预算.xlsx": "data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#217346"/><text x="8" y="11" font-size="8" fill="#fff" text-anchor="middle" font-family="Arial">X</text></svg>').toString("base64")}"
  };
  window.__boot = function () {
    var ms = {
      plugin: { id: 'com.my-search.mayelite' },
      log: function () {},
      store: { get: function (k, f) { return (k in window.__mem) ? window.__mem[k] : f; }, set: function (k, v) { window.__mem[k] = v; return true; }, remove: function () {}, keys: function () { return []; } },
      ui: { toast: function () {} },
      system: { writeClipboard: function () { return Promise.resolve(true); } },
      input: {
        attachments: function () { return Promise.resolve([]); },
        readFile: function () { return Promise.resolve('data:text/plain;base64,QQ=='); },
        listFolder: function (p) { return (window.__folders || []).indexOf(p) >= 0 ? Promise.resolve([]) : Promise.reject(new Error('x')); },
        open: function () { return Promise.resolve(true); },
        reveal: function () { return Promise.resolve(true); },
        fileIcons: function (es) { var o = {}; for (var i = 0; i < es.length; i++) { var ic = window.__iconReply[es[i].path]; if (ic) o[es[i].path] = ic; } return Promise.resolve(o); }
      }
    };
    var fn = new Function('ms','env','plugin','host','keyword','inputValue','onSubKeyword','md2html','openExternal', ${JSON.stringify(js)});
    fn(ms, {}, { id: 'com.my-search.mayelite' }, document.getElementById('app'), '', '', function () {}, function (s) { return s; }, function () { return Promise.resolve(true); });
  };
` }, sid);

await S("Page.navigate", { url: `${base}/ui/detail.html` }, sid);
await new Promise((r) => setTimeout(r, 400));
const ev = async (expr) => (await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value;

const SEED = `window.__folders = ['C:\\\\demo\\\\设计稿'];
window.__mem.pins = { version:1, cats:[{id:'c1',name:'工作'}], prefs:{view:'icon',sort:'manual',dir:'asc'},
  items:[
    { id:'a', path:'C:\\\\demo\\\\报告.docx', name:'报告.docx', kind:'file', cat:'default', createdAt:1000 },
    { id:'b', path:'C:\\\\demo\\\\演示.pptx', name:'演示.pptx', kind:'file', cat:'default', createdAt:2000 },
    { id:'c', path:'C:\\\\demo\\\\预算.xlsx', name:'预算.xlsx', kind:'file', cat:'c1', createdAt:3000 },
    { id:'d', path:'C:\\\\demo\\\\设计稿', name:'设计稿', kind:'folder', cat:'default', createdAt:4000 },
    { id:'e', path:'C:\\\\demo\\\\素材.zip', name:'素材.zip', kind:'file', cat:'c1', createdAt:5000 },
    { id:'f', path:'C:\\\\demo\\\\说明.md', name:'说明.md', kind:'file', cat:'default', createdAt:6000 }
  ] };
window.__boot();`;

for (const [theme, view] of [["theme-light", "icon"], ["theme-dark", "icon"], ["theme-light", "list"], ["theme-dark", "list"]]) {
  await ev(`document.documentElement.className = '${theme}'; ${SEED}`);
  await new Promise((r) => setTimeout(r, 200));
  await ev(`document.querySelector('#ml-viewmode [data-view="${view}"]').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const shot = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sid);
  const out = path.join(root, "test", `_shot-${theme.replace("theme-", "")}-${view}.png`);
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("已导出", path.relative(root, out));
}

try { chrome.kill(); } catch {}
server.close();
process.exit(0);