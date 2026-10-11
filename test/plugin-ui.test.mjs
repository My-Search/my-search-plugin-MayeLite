/**
 * MayeLite 快速启动 插件 —— 真实浏览器端到端测试（模拟宿主 IPC，无 Tauri）。
 *
 * 钉死的契约（这些都是「肉眼很难发现、但用户一定会踩」的点）：
 *
 *   1. **拖入即固定**：订阅宿主的 `ms-dropped-paths`（主窗口开着原生拖放处理器
 *      时，插件页的 HTML5 drop 永远不触发），拖入路径被写进 ms.store；
 *   2. **持久化**：刷新（等价于重开视图/重启应用）后固定项还在，且**顺序与
 *      分类**都还原；
 *   3. **打开降级**：本次已登记路径走 `ms.input.open`；跨会话路径（不在登记
 *      集合内）必须回退到 `openExternal`，否则重启后「点不开任何东西」；
 *   4. **去重**：同一路径反复拖入只留一份；
 *   5. **分类与排序**：新建分类、移动条目、排序切换都落盘并生效；
 *   6. **过滤**：搜索框过滤 + 子关键词（`快速启动 : xxx`）都收敛列表；
 *   7. **图标持久化**：固定时抓到的系统图标写进 store，刷新后仍是 <img> 而非字形；
 *   8. **旧宿主降级**：没有 `ms.input.fileIcons` 时不报错，纯字形回退。
 *
 * 用法: node test/plugin-ui.test.mjs
 *      （需本机装有 Chrome / Edge，否则跳过）
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = root;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/**
 * 样式校验用的宿主实现来源。
 *
 * 优先用仓库自带的 `tools/host/`（vendor 副本，保证本仓库**可独立跑测试**）；
 * 若设置了 MS_HOST_REPO，则改用宿主仓库的最新实现——升级 vendor 副本前先用它
 * 验一遍，避免上游行为变化悄悄打破插件。
 *
 * 校验两件事（都是线上真实生效的机制，本地不还原就等于没测）：
 *   1. CSS 经 `scopeCss(css, "#text_show .plugin-view")` 加前缀后注入；
 *   2. 主题变量来自宿主 style.css 的 html / html.theme-* 区块。
 */
function findHostSources() {
  const external = process.env.MS_HOST_REPO;
  if (external && existsSync(path.join(external, "src", "lib", "util.ts"))) {
    return {
      util: path.join(external, "src", "lib", "util.ts"),
      style: path.join(external, "src", "css", "style.css"),
      kind: "宿主仓库",
    };
  }
  const guessed = [
    path.join(root, "..", "my-search-desktop"),
    path.join(root, "..", "..", "my-search-desktop"),
  ].find((c) => existsSync(path.join(c, "src", "lib", "util.ts")));
  if (guessed) {
    return {
      util: path.join(guessed, "src", "lib", "util.ts"),
      style: path.join(guessed, "src", "css", "style.css"),
      kind: "宿主仓库",
    };
  }
  // 回退：仓库自带的 vendor 副本
  const vendored = path.join(root, "tools", "host", "scope-css.ts");
  if (existsSync(vendored)) {
    return { util: vendored, style: null, kind: "vendor 副本" };
  }
  return null;
}

const hostSources = findHostSources();
let scopeCss = null;
let themeCssSource = "";
if (hostSources) {
  try {
    ({ scopeCss } = await import(pathToFileURL(hostSources.util).href));
    if (hostSources.style) themeCssSource = readFileSync(hostSources.style, "utf8");
    console.log(`（样式校验使用${hostSources.kind}的实现）`);
  } catch (e) {
    console.log(`（提示）加载宿主 scopeCss 失败，样式作用域校验将跳过: ${e.message}`);
  }
} else {
  console.log("（提示）未找到可用的 scopeCss，样式作用域校验将跳过");
}
const PLUGIN_SCOPE = "#text_show .plugin-view";

/**
 * 抽取宿主 style.css 里的「插件共享主题变量」区块（html / html.theme-light /
 * html.theme-dark 三组 --token 定义）。
 *
 * 为什么必须用真实的一段：插件的 CSS 写的是 `var(--text, 兜底)`，兜底值只在
 * **独立开发**（没有宿主变量）时才该生效。测试若不注入宿主变量，就永远只看得到
 * 浅色兜底，暗色主题的真实观感完全测不到——那等于没测。
 */
function hostThemeCss(css) {
  const start = css.indexOf("html {");
  if (start < 0) return "";
  const out = [];
  let i = start;
  while (i < css.length) {
    const braceOpen = css.indexOf("{", i);
    if (braceOpen < 0) break;
    const header = css.slice(i, braceOpen).trim();
    if (!/^html(\.theme-(light|dark))?$/.test(header)) break;
    const close = css.indexOf("}", braceOpen);
    if (close < 0) break;
    out.push(css.slice(i, close + 1));
    i = close + 1;
    while (i < css.length && /\s/.test(css[i])) i++;
  }
  return out.join("\n");
}
const themeCss = hostThemeCss(themeCssSource);

/** 一个只服务插件目录的静态服务器：把 ui/detail.html 直接当页面打开。
 *
 *  注意两处刻意的「还原宿主行为」：
 *
 *  1. 返回的 HTML 里会**剥掉 `<script src="index.js">`**。真实宿主挂载插件时
 *     是用 `new Function(ms, env, ...)` 注入执行入口脚本的（见宿主
 *     usePluginViewHost 的 runPluginEntry），并不会真的走 script 标签；保留它
 *     会让浏览器在无注入参数的情况下直接执行 index.js，报 `ms is not defined`。
 *
 *  2. 页面补上宿主的容器层级 `#text_show > .plugin-view > .ms-plugin-session > #app`，
 *     并把 CSS 按宿主的方式（scoped 后注入 `<style>`）挂上——否则测的是一套
 *     线上不存在的渲染条件。 */
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const rel = u === "/" ? "/ui/detail.html" : u;
    const file = path.join(pluginDir, rel);
    if (!file.startsWith(pluginDir)) return res.writeHead(403).end("forbidden");
    let body = await readFile(file);
    const ext = path.extname(file);
    if (ext === ".html") {
      let html = String(body).replace(/<script\s+src=["']index\.js["']\s*>\s*<\/script>/i, "");
      const rawCss = await readFile(path.join(pluginDir, "ui", "detail.css"), "utf8");
      const css = scopeCss ? scopeCss(rawCss, PLUGIN_SCOPE) : rawCss;
      html = html.replace("</head>", `<style>${css}</style>\n</head>`);
      html = html.replace(
        /<body>/,
        '<body><div id="text_show"><div class="plugin-view"><div class="ms-plugin-session">'
      );
      html = html.replace(/<\/body>/, "</div></div></div></body>");
      body = Buffer.from(html, "utf8");
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.log("未找到浏览器，跳过");
  server.close();
  process.exit(0);
}

const profileDir = path.join(root, "test", "_chrome-profile-mayelite");
const chrome = spawn(bin, [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  `--user-data-dir=${profileDir}`,
  "about:blank",
]);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) resolve(m[0]);
  });
  setTimeout(() => reject(new Error("等待 DevTools 超时")), 20000);
});
const ws = new WebSocket(wsUrl);
// 每个场景都会挂一个 Runtime.exceptionThrown 监听器，场景数超过默认上限 10 时会告警。
// Node 的 WebSocket 是 EventTarget 语义：用 node:events 的 setMaxListeners 解限。
try {
  const { setMaxListeners } = await import("node:events");
  setMaxListeners(0, ws);
} catch { /* 老版本没有该 API：告警无害，忽略 */ }
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { result: targets } = await S("Target.getTargets");
const page = targets.targetInfos.find((t) => t.type === "page");
const { result: attach } = await S("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const sessionId = attach.sessionId;
await S("Page.enable", {}, sessionId);
await S("Runtime.enable", {}, sessionId);

const pageErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(
      m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "?"
    );
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) => {
  const r = await S(
    "Runtime.evaluate",
    { expression: expr, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || "eval error");
  }
  return r.result?.result?.value;
};

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ============================================================
 * 宿主桩：在页面加载前注入
 *
 * 模拟真实的宿主注入契约：index.js 由 `new Function(...)` 以具名参数执行，
 * 因此这里手工复刻那一步（与宿主 usePluginViewHost.runPluginEntry 一致）。
 * ============================================================ */

const pluginJs = readFileSync(path.join(pluginDir, "ui", "index.js"), "utf8");

/**
 * @param opts.iconApi    是否提供 ms.input.fileIcons（false = 模拟旧宿主）
 * @param opts.registered 本次会话「已被宿主登记」的路径（决定 ms.input.open 是否可用）
 * @param opts.openExternalThrows openExternal 是否失败（测错误提示）
 */
function bootstrap(opts = {}) {
  return `
  window.__opts = ${JSON.stringify({
    iconApi: opts.iconApi !== false,
    registered: opts.registered ?? [],
    openExternalThrows: !!opts.openExternalThrows,
    openFails: !!opts.openFails,
  })};

  // ---- 内存版 localStorage（等价于宿主的 pluginDataGet/Set 的命名空间） ----
  window.__mem = window.__mem || {};
  window.__log = window.__log || [];

  // ---- 宿主 API 桩 ----
  window.__buildMs = function () {
    var o = window.__opts;
    var mem = window.__mem;

    function norm(p) { return String(p || '').replace(/\\\\/g, '/').replace(/\\/+$/, '').toLowerCase(); }

    // 「已登记」集合必须用与插件相同的归一化口径（反斜杠 → 正斜杠、去尾斜杠、
    // 小写），否则 C:\a 与 c:/a 会被当成两条不同路径，判定恒为「未登记」。
    var reg = {};
    for (var i = 0; i < o.registered.length; i++) reg[norm(o.registered[i])] = true;

    window.__calls = { open: [], reveal: [], readFile: [], listFolder: [], fileIcons: [], external: [], clipboard: [] };

    var ms = {
      plugin: { id: 'com.my-search.mayelite', granted: function () { return ['ui.inlay','ui.notify','store','file.read']; } },
      log: function (level) { window.__log.push([level].concat([].slice.call(arguments, 1)).join(' ')); },
      store: {
        get: function (k, fb) { return (k in mem) ? mem[k] : fb; },
        set: function (k, v) { mem[k] = JSON.parse(JSON.stringify(v)); return true; },
        remove: function (k) { delete mem[k]; return true; },
        keys: function () { return Object.keys(mem); }
      },
      ui: { toast: function (t) { window.__log.push('toast:' + t); } },
      system: {
        writeClipboard: function (t) { window.__calls.clipboard.push(t); return Promise.resolve(true); }
      },
      // 宿主自定义快捷键动作：把插件注册的处理器收进 window.__shortcutHandlers，
      // 供测试用 window.__fireShortcut(name) 模拟「用户按下了全局热键」。
      shortcuts: (function () {
        window.__shortcutHandlers = {};
        return {
          onAction: function (name, handler) {
            if (typeof handler !== 'function') return function () {};
            (window.__shortcutHandlers[name] || (window.__shortcutHandlers[name] = [])).push(handler);
            return function () { window.__shortcutHandlers[name] = []; };
          },
          offAction: function (name) { delete window.__shortcutHandlers[name]; }
        };
      })(),
      input: {
        attachments: function () { return Promise.resolve(window.__attachments || []); },
        readFile: function (p) { window.__calls.readFile.push(p); return Promise.resolve('data:text/plain;base64,QUJD'); },
        listFolder: function (p, opt) {
          window.__calls.listFolder.push({ path: p, limit: (opt && opt.limit) || null });
          // 夹具：__folders 里的路径算文件夹，其余报「目标不是文件夹」
          if ((window.__folders || []).indexOf(p) >= 0) return Promise.resolve([]);
          return Promise.reject(new Error('目标不是文件夹'));
        },
        open: function (p) {
          window.__calls.open.push(p);
          if (o.openFails) return Promise.reject(new Error('路径不在已附加的内容范围内'));
          if (!reg[norm(p)]) return Promise.reject(new Error('路径不在已附加的内容范围内'));
          return Promise.resolve(true);
        },
        reveal: function (p) {
          window.__calls.reveal.push(p);
          if (!reg[norm(p)]) return Promise.reject(new Error('路径不在已附加的内容范围内'));
          return Promise.resolve(true);
        }
      }
    };
    if (o.iconApi) {
      ms.input.fileIcons = function (entries) {
        window.__calls.fileIcons.push(entries.map(function (e) { return e.path; }));
        var out = {};
        var reply = window.__iconReply || {};
        for (var i = 0; i < entries.length; i++) {
          var ic = reply[entries[i].path];
          if (ic) out[entries[i].path] = ic;
        }
        // 任一路径未登记 → 整批拒绝（与真实 Rust attachment_file_icons 同口径）
        for (var j = 0; j < entries.length; j++) {
          if (!reg[norm(entries[j].path)]) return Promise.reject(new Error('路径不在已附加的内容范围内'));
        }
        return Promise.resolve(out);
      };
    }
    return ms;
  };

  window.__boot = function () {
    var ms = window.__buildMs();
    var openExternal = function (p) {
      window.__calls.external.push(p);
      if (window.__opts.openExternalThrows) return Promise.reject(new Error('打开失败: 无关联程序'));
      return Promise.resolve(true);
    };
    // 与宿主 runPluginEntry 一致：具名参数注入（不是全局）
    var fn = new Function(
      'ms','env','plugin','host','keyword','inputValue','onSubKeyword','md2html','openExternal',
      ${JSON.stringify(pluginJs)}
    );
    window.__subKeywordHandler = null;
    fn(
      ms, {}, { id: 'com.my-search.mayelite', name: 'MayeLite 快速启动', version: '1.0.0' },
      document.getElementById('app'), '', '', function (h) { window.__subKeywordHandler = h; },
      function (s) { return s; }, openExternal
    );
  };

  /** 派发宿主的定向投递事件（拖入插件界面时由宿主发出） */
  window.__drop = function (paths) {
    document.dispatchEvent(new CustomEvent('ms-dropped-paths', { detail: { paths: paths }, bubbles: true }));
  };
  /** 派发「附件变化」广播 */
  window.__attachmentsChanged = function () {
    document.dispatchEvent(new CustomEvent('ms-attachments-changed'));
  };
  /** 模拟宿主派发一次自定义快捷键动作（全局热键被按下） */
  window.__fireShortcut = function (name) {
    var hs = (window.__shortcutHandlers || {})[name] || [];
    for (var i = 0; i < hs.length; i++) hs[i]();
    return hs.length;
  };
  `;
}

/** 打开页面并注入宿主桩；每个场景用独立 page（清空 store 与 DOM 状态） */
async function newPage(opts = {}, { folders = [], iconReply = {}, attachments = [] } = {}) {
  const { result: created } = await S("Target.createTarget", { url: "about:blank" });
  const { result: a } = await S("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const sid = a.sessionId;
  await S("Page.enable", {}, sid);
  await S("Runtime.enable", {}, sid);
  await S("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap(opts) }, sid);

  const errors = [];
  const onMsg = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown" && m.sessionId === sid) {
      errors.push(
        m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "?"
      );
    }
  };
  ws.addEventListener("message", onMsg);

  const S2 = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, sessionId: sid }));
    });
  const ev = async (expr) => {
    const r = await S2("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || "eval error");
    }
    return r.result?.result?.value;
  };

  await S2("Page.navigate", { url: `${base}/ui/detail.html` });
  await sleep(320);
  // 夹具数据必须先于 __boot 就位
  await ev(`window.__folders = ${JSON.stringify(folders)}; window.__iconReply = ${JSON.stringify(iconReply)}; window.__attachments = ${JSON.stringify(attachments)};`);
  await ev("window.__boot()");
  await sleep(60);
  return { sid, ev, errors, close: () => S("Target.closeTarget", { targetId: created.targetId }) };
}

/** 读取当前 store 里的固定项（等价于「应用重启后能读到什么」） */
const readStore = (ev) =>
  ev("JSON.parse(JSON.stringify(window.__mem.pins || null))");

/* ============================================================
 * 场景 1：拖入即固定 + 落盘
 * ============================================================ */
{
  const p = await newPage({ registered: ["C:\\demo\\项目A", "C:\\demo\\报告.docx"] }, {
    folders: ["C:\\demo\\项目A"],
  });
  await p.ev("window.__drop(['C:\\\\demo\\\\项目A', 'C:\\\\demo\\\\报告.docx'])");
  await sleep(220);

  const st = await readStore(p.ev);
  check("拖入后固定项已落盘", !!st && Array.isArray(st.items) && st.items.length === 2,
    JSON.stringify(st && st.items && st.items.length));
  check("文件夹被识别为 folder（listFolder 成功）",
    !!st && st.items.some((i) => i.kind === "folder" && /项目A$/.test(i.path)),
    JSON.stringify(st && st.items.map((i) => i.kind + ":" + i.path)));
  check("文件被识别为 file",
    !!st && st.items.some((i) => i.kind === "file" && /报告\.docx$/.test(i.path)));
  check("固定项落在默认分类",
    !!st && st.items.every((i) => i.cat === "default"));
  const rows = await p.ev("document.querySelectorAll('.ml-item').length");
  check("界面渲染出 2 行", rows === 2, `rows=${rows}`);
  await p.close();
}

/* ============================================================
 * 场景 2：去重（同一路径反复拖入）
 * ============================================================ */
{
  const p = await newPage({ registered: ["C:\\a.txt"] }, {});
  await p.ev("window.__drop(['C:\\\\a.txt'])");
  await sleep(160);
  await p.ev("window.__drop(['C:\\\\a.txt'])");
  await sleep(160);
  const st = await readStore(p.ev);
  check("同一路径反复拖入只留一份", !!st && st.items.length === 1, JSON.stringify(st && st.items.length));
  const status = await p.ev("document.getElementById('ml-status').textContent");
  check("重复时给出可读提示", /已经在固定列表/.test(status || ""), status);
  await p.close();
}

/* ============================================================
 * 场景 3：持久化（刷新后还原条目 / 分类 / 偏好）
 * ============================================================ */
{
  const p = await newPage({ registered: ["C:\\keep\\x.txt"] }, {});
  await p.ev("window.__drop(['C:\\\\keep\\\\x.txt'])");
  await sleep(160);
  // 建一个分类并移入
  await p.ev(`
    (function(){
      var tabs = document.getElementById('ml-tabs');
      var addBtn = tabs.querySelector('[data-act="new-cat"]');
      addBtn.click();
    })()
  `);
  await sleep(40);
  await p.ev(`
    (function(){
      var inp = document.getElementById('ml-prompt-input');
      inp.value = '工作';
      document.getElementById('ml-prompt-ok').click();
    })()
  `);
  await sleep(80);
  const st1 = await readStore(p.ev);
  check("新建分类已落盘", !!st1 && st1.cats.length === 1 && st1.cats[0].name === "工作",
    JSON.stringify(st1 && st1.cats));

  // 把条目移入「工作」
  await p.ev(`
    (function(){
      var row = document.querySelector('.ml-item');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    })()
  `);
  await sleep(40);
  const catId = await p.ev("(JSON.parse(JSON.stringify(window.__mem.pins))).cats[0].id");
  await p.ev(`document.querySelector('#ml-menu [data-act="cat:${catId}"]').click()`);
  await sleep(80);
  const st2 = await readStore(p.ev);
  check("条目已移入新分类", !!st2 && st2.items[0].cat === catId, JSON.stringify(st2 && st2.items[0].cat));

  // 切视图 + 切排序（都应落盘）
  await p.ev("document.querySelector('#ml-viewmode [data-view=\"list\"]').click()");
  await sleep(40);
  await p.ev("document.querySelector('#ml-sort [data-sort=\"name\"]').click()");
  await sleep(60);
  const st3 = await readStore(p.ev);
  check("视图偏好已落盘（list）", !!st3 && st3.prefs.view === "list", JSON.stringify(st3 && st3.prefs));
  check("排序偏好已落盘（name）", !!st3 && st3.prefs.sort === "name");
  const listClass = await p.ev("document.getElementById('ml-list').className");
  check("列表视图类名生效", /is-list/.test(listClass), listClass);

  // 「刷新」：新页面但沿用同一份 store（用 localStorage 承载 mem 跨导航）
  const stSnapshot = JSON.stringify(st3);
  await p.ev(`localStorage.setItem('__persist', ${JSON.stringify(stSnapshot)})`);
  await p.ev("location.reload()");
  await sleep(400);
  // 重新 boot，并把 store 灌回去（等价于应用重启后 ms.store 里仍是这些数据）
  await p.ev(`window.__mem.pins = JSON.parse(localStorage.getItem('__persist')); window.__boot();`);
  await sleep(120);
  const rows = await p.ev("document.querySelectorAll('.ml-item').length");
  check("刷新后固定项仍在（1 行）", rows === 1, `rows=${rows}`);
  const tabText = await p.ev("document.getElementById('ml-tabs').textContent");
  check("刷新后分类页签还原", /工作/.test(tabText || ""), tabText);
  const activeView = await p.ev("document.getElementById('ml-list').className");
  check("刷新后视图偏好还原", /is-list/.test(activeView), activeView);
  await p.close();
}

/* ============================================================
 * 场景 4：打开降级（已登记 → ms.input.open；跨会话 → openExternal）
 * ============================================================ */
{
  // 4a：本次已登记的路径
  const p = await newPage({ registered: ["C:\\reg\\a.txt"] }, {});
  await p.ev("window.__drop(['C:\\\\reg\\\\a.txt'])");
  await sleep(180);
  await p.ev("document.querySelector('.ml-item').click()");
  await sleep(140);
  const calls = await p.ev("JSON.parse(JSON.stringify(window.__calls))");
  check("已登记路径走 ms.input.open", calls.open.length === 1 && calls.external.length === 0,
    `open=${JSON.stringify(calls.open)} external=${JSON.stringify(calls.external)}`);
  await p.close();

  // 4b：跨会话（store 里有条目，但本次没有登记任何路径）
  const p2 = await newPage({ registered: [] }, {});
  await p2.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'icon',sort:'manual',dir:'desc'},
      items:[{ id:'x1', path:'C:\\\\old\\\\b.txt', name:'b.txt', kind:'file', cat:'default', createdAt:1 }] };
    window.__boot();
  `);
  await sleep(120);
  await p2.ev("document.querySelector('.ml-item').click()");
  await sleep(160);
  const calls2 = await p2.ev("JSON.parse(JSON.stringify(window.__calls))");
  check("跨会话路径回退到 openExternal（重启后仍能打开）",
    calls2.external.length === 1 && calls2.open.length === 0,
    `open=${JSON.stringify(calls2.open)} external=${JSON.stringify(calls2.external)}`);
  check("openExternal 收到的是条目真实路径", calls2.external[0] === "C:\\old\\b.txt", JSON.stringify(calls2.external));
  await p2.close();
}

/* ============================================================
 * 场景 5：定位降级（已登记 → reveal；跨会话 → 打开所在目录）
 * ============================================================ */
{
  // 说明：插件内部的「本次已登记」集合来自**附件**（启动时拉一次）与**拖入投递**。
  // 因此这里把 a 放进附件夹具（= 本次会话里用户粘过/拖过它），b 则只存在于 store
  // （= 跨会话的固定项）。两者正好覆盖 reveal 的两条路径。
  const p = await newPage({ registered: ["C:\\reg\\f.txt"] }, {
    attachments: [{ kind: "file", name: "f.txt", path: "C:\\reg\\f.txt" }],
  });
  await p.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'list',sort:'manual',dir:'desc'},
      items:[
        { id:'a', path:'C:\\\\reg\\\\f.txt', name:'f.txt', kind:'file', cat:'default', createdAt:1 },
        { id:'b', path:'C:\\\\old\\\\g.txt', name:'g.txt', kind:'file', cat:'default', createdAt:2 }
      ] };
    window.__boot();
  `);
  await sleep(180);
  await p.ev("document.querySelector('.ml-item[data-id=\"a\"] [data-act=\"reveal\"]').click()");
  await sleep(140);
  const c1 = await p.ev("JSON.parse(JSON.stringify(window.__calls))");
  check("已登记路径的「定位」走 ms.input.reveal", c1.reveal.length === 1, JSON.stringify(c1.reveal));

  await p.ev("document.querySelector('.ml-item[data-id=\"b\"] [data-act=\"reveal\"]').click()");
  await sleep(140);
  const c2 = await p.ev("JSON.parse(JSON.stringify(window.__calls))");
  check("跨会话条目的「定位」降级为打开所在目录",
    c2.external.some((x) => x === "C:\\old"), JSON.stringify(c2.external));
  await p.close();
}

/* ============================================================
 * 场景 6：过滤（搜索框 + 子关键词）
 * ============================================================ */
{
  const p = await newPage({ registered: [] }, {});
  await p.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'list',sort:'manual',dir:'desc'},
      items:[
        { id:'a', path:'C:\\\\d\\\\周报.docx', name:'周报.docx', kind:'file', cat:'default', createdAt:1 },
        { id:'b', path:'C:\\\\d\\\\预算.xlsx', name:'预算.xlsx', kind:'file', cat:'default', createdAt:2 }
      ] };
    window.__boot();
  `);
  await sleep(140);
  await p.ev(`
    (function(){
      var s = document.getElementById('ml-search');
      s.value = '周报';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(80);
  let rows = await p.ev("document.querySelectorAll('.ml-item').length");
  check("搜索框过滤收敛到 1 行", rows === 1, `rows=${rows}`);

  await p.ev("document.getElementById('ml-search-clear').click()");
  await sleep(80);
  rows = await p.ev("document.querySelectorAll('.ml-item').length");
  check("清除过滤后恢复 2 行", rows === 2, `rows=${rows}`);

  // 子关键词：宿主把「快速启动 : 预算」的子词转发进来
  await p.ev("window.__subKeywordHandler && window.__subKeywordHandler('预算')");
  await sleep(80);
  rows = await p.ev("document.querySelectorAll('.ml-item').length");
  check("子关键词转发后收敛到 1 行", rows === 1, `rows=${rows}`);
  const shown = await p.ev("document.querySelector('.ml-item-name').textContent");
  check("剩下的是「预算.xlsx」", /预算/.test(shown || ""), shown);
  await p.close();
}

/* ============================================================
 * 场景 7：图标持久化（固定时抓到的图标写进 store）
 * ============================================================ */
{
  const iconReply = { "C:\\ic\\a.docx": "data:image/png;base64,AAAAsysicon" };
  const p = await newPage({ registered: ["C:\\ic\\a.docx"] }, { iconReply });
  await p.ev("window.__drop(['C:\\\\ic\\\\a.docx'])");
  await sleep(260);
  const st = await readStore(p.ev);
  check("固定时抓到的系统图标已落盘",
    !!st && !!st.items[0].icon && st.items[0].icon.indexOf("data:image/") === 0,
    JSON.stringify(st && st.items[0] && String(st.items[0].icon).slice(0, 30)));
  const imgCount = await p.ev("document.querySelectorAll('.ml-item img.ml-icon-img').length");
  check("界面渲染成 <img> 而非字形", imgCount === 1, `img=${imgCount}`);

  // 刷新（本次没有登记任何路径）→ 图标仍来自 store
  await p.ev(`localStorage.setItem('__persist', JSON.stringify(window.__mem.pins))`);
  await p.ev("location.reload()");
  await sleep(400);
  await p.ev(`window.__mem.pins = JSON.parse(localStorage.getItem('__persist')); window.__boot();`);
  await sleep(160);
  const imgCount2 = await p.ev("document.querySelectorAll('.ml-item img.ml-icon-img').length");
  check("刷新后（无登记路径）图标仍显示（来自 store）", imgCount2 === 1, `img=${imgCount2}`);
  await p.close();
}

/* ============================================================
 * 场景 8：旧宿主降级（无 fileIcons）
 * ============================================================ */
{
  const p = await newPage({ iconApi: false, registered: ["C:\\old\\a.txt"] }, {});
  await p.ev("window.__drop(['C:\\\\old\\\\a.txt'])");
  await sleep(200);
  const st = await readStore(p.ev);
  check("无 fileIcons 时固定仍成功", !!st && st.items.length === 1);
  const glyph = await p.ev("document.querySelectorAll('.ml-item svg.ml-glyph').length");
  check("退回内联 SVG 字形", glyph === 1, `glyph=${glyph}`);
  check("页面无未捕获异常", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
}

/* ============================================================
 * 场景 9：打开失败时给出可读错误（不静默）
 * ============================================================ */
{
  const p = await newPage({ registered: [], openExternalThrows: true }, {});
  await p.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'icon',sort:'manual',dir:'desc'},
      items:[{ id:'x', path:'C:\\\\gone\\\\z.txt', name:'z.txt', kind:'file', cat:'default', createdAt:1 }] };
    window.__boot();
  `);
  await sleep(140);
  await p.ev("document.querySelector('.ml-item').click()");
  await sleep(160);
  const status = await p.ev("document.getElementById('ml-status').textContent");
  check("打开失败时状态行给出原因", /打开失败/.test(status || ""), status);
  await p.close();
}

/* ============================================================
 * 场景 10：分类管理（重命名 / 删除后条目归未分类）
 * ============================================================ */
{
  const p = await newPage({ registered: [] }, {});
  await p.ev(`
    window.__mem.pins = { version:1, cats:[{id:'c1',name:'旧名'}], prefs:{view:'list',sort:'manual',dir:'desc'},
      items:[{ id:'a', path:'C:\\\\d\\\\a.txt', name:'a.txt', kind:'file', cat:'c1', createdAt:1 }] };
    window.__boot();
  `);
  await sleep(140);
  // 分类页签右键 → 重命名
  await p.ev(`
    (function(){
      var tab = document.querySelector('#ml-tabs [data-cat="c1"]');
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    })()
  `);
  await sleep(60);
  await p.ev(`document.querySelector('#ml-menu [data-act="cat-rename:c1"]').click()`);
  await sleep(60);
  await p.ev(`
    (function(){
      document.getElementById('ml-prompt-input').value = '新名';
      document.getElementById('ml-prompt-ok').click();
    })()
  `);
  await sleep(100);
  const st1 = await readStore(p.ev);
  check("分类重命名已落盘", !!st1 && st1.cats[0].name === "新名", JSON.stringify(st1 && st1.cats));

  // 删除分类 → 条目归入未分类
  await p.ev(`
    (function(){
      var tab = document.querySelector('#ml-tabs [data-cat="c1"]');
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    })()
  `);
  await sleep(60);
  await p.ev(`document.querySelector('#ml-menu [data-act="cat-del:c1"]').click()`);
  await sleep(120);
  const st2 = await readStore(p.ev);
  check("删除分类后分类消失", !!st2 && st2.cats.length === 0, JSON.stringify(st2 && st2.cats));
  check("删除分类后条目归入未分类（数据不丢）", !!st2 && st2.items.length === 1 && st2.items[0].cat === "default",
    JSON.stringify(st2 && st2.items));
  await p.close();
}

/* ============================================================
 * 场景 11：手动排序（置顶）
 * ============================================================ */
{
  const p = await newPage({ registered: [] }, {});
  await p.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'list',sort:'manual',dir:'asc'},
      items:[
        { id:'a', path:'C:\\\\d\\\\a.txt', name:'a.txt', kind:'file', cat:'default', createdAt:1000 },
        { id:'b', path:'C:\\\\d\\\\b.txt', name:'b.txt', kind:'file', cat:'default', createdAt:2000 },
        { id:'c', path:'C:\\\\d\\\\c.txt', name:'c.txt', kind:'file', cat:'default', createdAt:3000 }
      ] };
    window.__boot();
  `);
  await sleep(140);
  let order = await p.ev("[].slice.call(document.querySelectorAll('.ml-item-name')).map(function(e){return e.textContent})");
  check("初始手动顺序 = a,b,c", JSON.stringify(order) === JSON.stringify(["a.txt", "b.txt", "c.txt"]), JSON.stringify(order));

  // 把 c 置顶
  await p.ev(`
    (function(){
      var row = document.querySelector('.ml-item[data-id="c"]');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    })()
  `);
  await sleep(60);
  await p.ev(`document.querySelector('#ml-menu [data-act="top"]').click()`);
  await sleep(120);
  order = await p.ev("[].slice.call(document.querySelectorAll('.ml-item-name')).map(function(e){return e.textContent})");
  check("置顶后顺序 = c,a,b", JSON.stringify(order) === JSON.stringify(["c.txt", "a.txt", "b.txt"]), JSON.stringify(order));
  await p.close();
}

/* ============================================================
 * 场景 12：右键菜单（复制路径 / 重命名 / 移除）
 * ============================================================ */
{
  const p = await newPage({ registered: [] }, {});
  await p.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'list',sort:'manual',dir:'desc'},
      items:[{ id:'a', path:'C:\\\\d\\\\a.txt', name:'a.txt', kind:'file', cat:'default', createdAt:1 }] };
    window.__boot();
  `);
  await sleep(140);
  const openMenu = `
    (function(){
      var row = document.querySelector('.ml-item[data-id="a"]');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    })()`;

  // 复制路径
  await p.ev(openMenu);
  await sleep(60);
  await p.ev(`document.querySelector('#ml-menu [data-act="copy"]').click()`);
  await sleep(120);
  const clip = await p.ev("JSON.parse(JSON.stringify(window.__calls.clipboard))");
  check("右键「复制路径」写入剪贴板", clip.length === 1 && clip[0] === "C:\\d\\a.txt", JSON.stringify(clip));

  // 重命名
  await p.ev(openMenu);
  await sleep(60);
  await p.ev(`document.querySelector('#ml-menu [data-act="rename"]').click()`);
  await sleep(60);
  await p.ev(`
    (function(){
      document.getElementById('ml-prompt-input').value = '我的报告';
      document.getElementById('ml-prompt-ok').click();
    })()
  `);
  await sleep(120);
  const st = await readStore(p.ev);
  check("重命名写入 customName", !!st && st.items[0].customName === "我的报告", JSON.stringify(st && st.items[0]));
  const label = await p.ev("document.querySelector('.ml-item-name').textContent");
  check("界面显示新名字", /我的报告/.test(label || ""), label);

  // 移除
  await p.ev(openMenu);
  await sleep(60);
  await p.ev(`document.querySelector('#ml-menu [data-act="remove"]').click()`);
  await sleep(120);
  const st2 = await readStore(p.ev);
  check("右键「移除」删除条目", !!st2 && st2.items.length === 0, JSON.stringify(st2 && st2.items));
  const emptyShown = await p.ev("!document.getElementById('ml-empty').hidden");
  check("移除后显示空状态", emptyShown === true);
  await p.close();
}

/* ============================================================
 * 场景 13：老实例不再响应（重挂后不重复固定）
 * ============================================================ */
{
  const p = await newPage({ registered: ["C:\\dup\\a.txt"] }, {});
  // 模拟宿主重挂：把旧 DOM 摘掉再执行一次脚本（旧实例的 document 监听器仍在）
  await p.ev(`
    (function(){
      var old = document.getElementById('app');
      var holder = document.createElement('div');
      holder.id = 'parking';
      document.body.appendChild(holder);
      holder.appendChild(old);   // 旧实例被停靠（仍 isConnected）
      var fresh = old.cloneNode(true);
      // cloneNode 不会复制监听器，但会复制 DOM；这里换掉 id 里的元素引用即可
      fresh.id = 'app';
      document.body.appendChild(fresh);
      window.__boot();           // 新实例：document.getElementById('app') === fresh
    })()
  `);
  await sleep(160);
  const before = await readStore(p.ev);
  const beforeCount = before && before.items ? before.items.length : 0;
  await p.ev("window.__drop(['C:\\\\dup\\\\a.txt'])");
  await sleep(200);
  const after = await readStore(p.ev);
  const afterCount = after && after.items ? after.items.length : 0;
  check("重挂后一次拖入只固定一次（老实例已让位）",
    afterCount - beforeCount === 1, `before=${beforeCount} after=${afterCount}`);
  await p.close();
}

/* ============================================================
 * 场景 14：宿主 CSS 作用域下样式仍然生效
 *
 * 宿主把插件 CSS 经 scopeCss 加 `#text_show .plugin-view` 前缀后注入，
 * 从不作为全局样式。若插件的选择器写法与 scopeCss 不兼容（例如依赖
 * `body` / `:root` 改写，或用了 scoped 之后失效的选择器形态），
 * 界面上会「DOM 都在、但样式全丢」——本用例把这条真实风险钉住。
 * ============================================================ */
if (scopeCss) {
  const p = await newPage({ registered: [] }, {});
  await p.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'list',sort:'manual',dir:'desc'},
      items:[{ id:'a', path:'C:\\\\d\\\\a.txt', name:'a.txt', kind:'file', cat:'default', createdAt:1 }] };
    window.__boot();
  `);
  await sleep(160);
  // 容器层级与 scoped 样式确实生效：flex 布局 + 行高 + 品牌色变量
  const probe = await p.ev(`
    (function(){
      var app = document.getElementById('app');
      var row = document.querySelector('.ml-item');
      var cs = getComputedStyle(app);
      var rs = getComputedStyle(row);
      return {
        hasScope: !!document.querySelector('#text_show .plugin-view .ms-plugin-session #app'),
        display: cs.display,
        rowDisplay: rs.display,
        gap: cs.gap,
        fontSize: cs.fontSize,
        paddingLeft: cs.paddingLeft
      };
    })()
  `);
  check("页面处于宿主的容器层级下（#text_show > .plugin-view > 会话载体）", probe.hasScope === true);
  check("scoped 后 .ml 的 flex 布局生效", probe.display === "flex", JSON.stringify(probe));
  check("scoped 后条目行 display 生效", probe.rowDisplay === "flex", JSON.stringify(probe));
  check("scoped 后 gap / 字号生效", probe.gap !== "normal" && probe.fontSize === "13px", JSON.stringify(probe));
  check("scoped 后插件自带 padding 生效（抵消宿主的负 margin）", probe.paddingLeft === "16px", probe.paddingLeft);

  // 背景必须由插件自己给：宿主的暗色规则只作用在 body / #searchBox / #my_search_box，
  // `#text_show .plugin-view` 这块没有背景——不自带的话暗色下会露出宿主白底。
  const bg = await p.ev(`
    (function(){
      var cs = getComputedStyle(document.getElementById('app'));
      return { bg: cs.backgroundColor, minHeight: cs.minHeight, boxSizing: cs.boxSizing };
    })()
  `);
  check("插件自带不透明背景（否则暗色主题下露白底）",
    !!bg.bg && bg.bg !== "rgba(0, 0, 0, 0)" && bg.bg !== "transparent", JSON.stringify(bg));
  check("插件撑满宿主区域（背景不留半截）",
    bg.minHeight === "100%" && bg.boxSizing === "border-box", JSON.stringify(bg));
  await p.close();
}

/* ============================================================
 * 场景 15：启动时补抓图标必须触发重绘
 *
 * 回归用例。此前的 bug：fetchIcons 恒返回 0，调用方写的是 `if (n) commit()`，
 * 于是固定项重启后即使能抓到系统图标，界面也一直显示字形，直到用户下一次
 * 交互才刷新（肉眼表现为「重启后图标没了」）。这里直接固定住「启动补抓后
 * 界面必须自己变成 <img>」。
 * ============================================================ */
{
  const iconReply = { "C:\\boot\\a.docx": "data:image/png;base64,AAAAYm9vdGljb24=" };
  const p = await newPage({ registered: ["C:\\boot\\a.docx"] }, { iconReply, attachments: [{ kind: "file", name: "a.docx", path: "C:\\boot\\a.docx" }] });
  // 先落一份「没有图标」的 store（模拟上次会话没抓到图标），再启动
  await p.ev(`
    localStorage.setItem('__seed', JSON.stringify({ version:1, cats:[], prefs:{view:'icon',sort:'manual',dir:'asc'},
      items:[{ id:'a', path:'C:\\\\boot\\\\a.docx', name:'a.docx', kind:'file', cat:'default', createdAt:1 }] }));
    window.__mem.pins = JSON.parse(localStorage.getItem('__seed'));
    window.__boot();
  `);
  await sleep(320);
  const imgCount = await p.ev("document.querySelectorAll('.ml-item img.ml-icon-img').length");
  check("启动补抓图标后界面自动重绘成 <img>（无需额外交互）", imgCount === 1, `img=${imgCount}`);
  const st = await readStore(p.ev);
  check("补抓到的图标同时落盘", !!st && st.items[0].icon && st.items[0].icon.indexOf("data:image/") === 0,
    JSON.stringify(st && st.items[0]));
  await p.close();
}

/* ============================================================
 * 场景 16：全局快捷键动作（清单 contributes.shortcut → 宿主转发）
 *
 * 宿主把清单里声明的本地动作名 `open` 注册成全局热键（默认 Ctrl+Alt+B），
 * 按下后打开本视图并把动作名派发给插件脚本。插件用
 * `ms.shortcuts.onAction('open', fn)` 接住并把焦点落到顶部过滤框，
 * 使用户可直接输入关键词过滤固定项。
 * ============================================================ */
{
  const p = await newPage({ registered: [] }, {});
  await p.ev(`
    window.__mem.pins = { version:1, cats:[], prefs:{view:'list',sort:'manual',dir:'desc'},
      items:[
        { id:'a', path:'C:\\\\d\\\\周报.docx', name:'周报.docx', kind:'file', cat:'default', createdAt:1 }
      ] };
    window.__boot();
  `);
  await sleep(140);

  const registered = await p.ev("(window.__shortcutHandlers && window.__shortcutHandlers['open'] || []).length");
  check("插件已注册 open 快捷键动作处理器", registered === 1, `handlers=${registered}`);

  // 先把焦点挪到别的控件上，模拟「按热键前焦点不在过滤框」
  await p.ev("document.getElementById('ml-add').focus()");
  const before = await p.ev("document.activeElement && document.activeElement.id");
  check("触发前焦点不在过滤框", before !== "ml-search", `active=${before}`);

  // 模拟宿主派发一次 open 动作
  const fired = await p.ev("window.__fireShortcut('open')");
  await sleep(60);
  const after = await p.ev("document.activeElement && document.activeElement.id");
  check("热键派发后焦点落到过滤框（可直接输入关键词）", after === "ml-search", `active=${after}`);
  check("派发确实命中至少一个处理器", fired >= 1, `fired=${fired}`);

  // 未注册的动作名不应报错（清单改版后新增动作的兜底）
  const unknownFired = await p.ev("window.__fireShortcut('unknown-action')");
  check("未知动作名静默忽略（不抛错）", unknownFired === 0, `fired=${unknownFired}`);
  await p.close();
}

/* ============================================================
 * 收尾
 * ============================================================ */
check("全流程无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
try { chrome.kill(); } catch { /* ignore */ }
server.close();
process.exit(fail === 0 ? 0 : 1);