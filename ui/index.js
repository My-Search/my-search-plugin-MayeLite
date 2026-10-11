/**
 * MayeLite 快速启动 —— 把常用文件/文件夹拖进来固定，随时一键打开。
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 *
 * ## 功能（对齐 Maye Lite 的核心体验）
 *   1. 多文件/文件夹**拖拽固定**（拖到本界面即固定，不污染搜索框附件）；
 *   2. **分类**：新建/重命名/删除分类，条目可在分类间移动；
 *   3. **排序**：自定义（手动置顶/上移/下移）、添加时间、名称、类型，可升降序；
 *   4. **图标 / 列表**两种视图；
 *   5. 单击打开、右键菜单（定位、复制路径、重命名、移动分类、排序、移除）；
 *   6. 名称/路径过滤（含「快速启动 : 关键词」子搜索）；
 *   7. 系统文件图标（资源管理器同款）+ 无图标时的内联 SVG 字形回退。
 *
 * ## 关键设计：固定项如何「跨会话打开」
 *
 * 宿主的 `ms.input.*` 全部受 `file.read` 权限与**「路径必须落在已登记的附加
 * 集合内」**双重校验，而那个集合是 Rust 进程内的静态表：只由用户**当场**
 * 粘贴/拖入产生，**应用重启后清空**，且插件无权自行登记（`attachments_sync`
 * 是宿主内部接口，插件拿不到裸 IPC）。
 *
 * 于是打开分两层（见 openEntry）：
 *   1. `ms.input.open(path)` —— 文档化通道，适用于**本次会话**拖入/粘贴过、
 *      因而已被宿主登记的路径；
 *   2. 宿主注入的 `openExternal(path)` —— 把本地路径交给系统默认程序
 *      （Windows 走 ShellExecute 语义，文件与文件夹都能开）。固定项天生要
 *      跨会话打开任意路径，这是宿主提供给插件的唯一可用通道。
 *
 * 同理，**系统图标**（`ms.input.fileIcons`）也只对已登记路径生效。因此本插件
 * 在**固定那一刻**把图标字节（PNG data URL）一并存进 `ms.store`，重启后照样
 * 显示真实图标；拿不到时退回内联 SVG 字形，不留空白。
 *
 * ## 生命周期
 *
 * 清单声明 `closeBehavior: "minimize"`：关闭视图只是把 DOM 停放到宿主停车区，
 * 脚本上下文**保活**（不会重跑）。所以任何写操作都必须**即时落盘**，不能等
 * 卸载时保存；重开时也不能指望重新初始化。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  /** 本实例的根节点（会话被卸载后脱离文档；老实例靠它判活，不打扰新实例） */
  var rootEl = document.getElementById("app");

  // ===== 常量 =====
  /** 存储键（ms.store 命名空间下；随插件卸载/清数据一并清除） */
  var STORE_KEY = "pins";
  /** 数据版本（迁移用） */
  var SCHEMA_VERSION = 1;
  /** 「全部」分类的保留 id（用户不能新建同名分类） */
  var CAT_ALL = "__all__";
  /** 默认分类 id（未分类） */
  var CAT_DEFAULT = "default";
  /** 图标 data URL 的存储预算（字节）。localStorage 约 5MB，留足余量给条目本身。 */
  var ICON_BUDGET = 1.5 * 1024 * 1024;
  /** 单个图标 data URL 超过这个大小就不存（异常大图标不值得占预算） */
  var ICON_MAX_ONE = 64 * 1024;
  /** 过滤输入长度上限（防超长串拖慢匹配） */
  var QUERY_MAX = 60;

  /** 类型 → 内联 SVG 字形（取不到系统图标时的回退；用 currentColor 跟随主题） */
  var GLYPHS = {
    folder:
      '<path d="M1.75 4.25A1.5 1.5 0 0 1 3.25 2.75H6L7.5 4.25h5.25a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5v-7.5Z" fill="currentColor"/>',
    image:
      '<path d="M2.5 3A1.5 1.5 0 0 1 4 1.5h8A1.5 1.5 0 0 1 13.5 3v10A1.5 1.5 0 0 1 12 14.5H4A1.5 1.5 0 0 1 2.5 13V3Zm2 1.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm-2 8.05 3.2-3.1 2.2 2.05 2.35-2.6 3.25 3.65v.7a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5v-.7Z" fill="currentColor"/>',
    video:
      '<path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h5a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 9 14H4a1.5 1.5 0 0 1-1.5-1.5v-9Zm7.5 3.1 3.05-2.1a.6.6 0 0 1 .95.5v6a.6.6 0 0 1-.95.5L10 9.4v-2.8Z" fill="currentColor"/>',
    audio:
      '<path d="M6 2.4c0-.6.5-1 1.1-.9l5 1.1c.5.1.9.6.9 1.1v6.9a2.35 2.35 0 1 1-1.5-2.2V5.3l-4-.9v6.2A2.35 2.35 0 1 1 6 8.4V2.4Z" fill="currentColor"/>',
    doc:
      '<path d="M3.5 2A1.5 1.5 0 0 1 5 .5h3.8L13 4.7V14a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 14V3.5A1.5 1.5 0 0 1 3.5 2Zm5 .6V5h2.4L8.5 2.6ZM4.5 7.5h7v1.2h-7V7.5Zm0 2.6h7v1.2h-7v-1.2Z" fill="currentColor"/>',
    archive:
      '<path d="M2.5 3A1.5 1.5 0 0 1 4 1.5h8A1.5 1.5 0 0 1 13.5 3v2H2.5V3Zm0 3.5h11V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V6.5ZM7 8v1.5h2V8H7Z" fill="currentColor"/>',
    code:
      '<path d="M5.6 4.3 2.4 7.5a.7.7 0 0 0 0 1l3.2 3.2 1-1L3.9 8l2.7-2.7-1-1Zm4.8 0-1 1L12.1 8l-2.7 2.7 1 1 3.2-3.2a.7.7 0 0 0 0-1l-3.2-3.2Z" fill="currentColor"/>',
    app:
      '<path d="M2.5 4.5A2 2 0 0 1 4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7Zm3.7 1.3L4 8l2.2 2.2 1-1L5.9 8l1.3-1.3-1-.9Zm3.6 0-1 .9L10.1 8l-1.3 1.2 1 1L12 8l-2.2-2.2Z" fill="currentColor"/>',
    file:
      '<path d="M3.5 2A1.5 1.5 0 0 1 5 .5h3.8L13 4.7V14a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 14V3.5A1.5 1.5 0 0 1 3.5 2Zm5 .6V5h2.4L8.5 2.6Z" fill="currentColor"/>',
  };

  /** 扩展名 → 字形 key（未命中归 file） */
  var EXT_GLYPH = (function () {
    var map = {};
    function put(key, exts) {
      for (var i = 0; i < exts.length; i++) map[exts[i]] = key;
    }
    put("image", ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif", "psd"]);
    put("video", ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts"]);
    put("audio", ["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac", "wma", "ape", "alac", "mid", "midi"]);
    put("doc", ["doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "pdf", "txt", "md", "markdown", "rtf", "csv", "odt", "ods", "odp", "epub"]);
    put("archive", ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "zst", "jar", "cab", "iso"]);
    put("code", ["js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "php", "rb", "json", "html", "htm", "css", "scss", "less", "sh", "ps1", "bat", "cmd", "yml", "yaml", "toml", "xml", "sql", "ini", "conf"]);
    put("app", ["exe", "msi", "bat", "cmd", "com", "lnk", "url", "appx", "msix", "apk", "dmg", "app"]);
    return map;
  })();

  // ===== DOM =====
  var dom = {};
  (function () {
    var ids = [
      "ml-stats", "ml-viewmode", "ml-add", "ml-search", "ml-search-clear", "ml-tabs",
      "ml-sort", "ml-sort-dir", "ml-status", "ml-list", "ml-empty",
      "ml-empty-text", "ml-empty-hint", "ml-menu", "ml-prompt", "ml-prompt-title",
      "ml-prompt-input", "ml-prompt-cancel", "ml-prompt-ok",
    ];
    for (var i = 0; i < ids.length; i++) dom[ids[i]] = document.getElementById(ids[i]);
  })();

  // ===== 状态 =====
  /** 全部固定项：{ id, path, name, customName?, kind, cat, createdAt, icon? } */
  var items = [];
  /** 分类：{ id, name }（不含「全部」） */
  var cats = [];
  /** 偏好：{ view, sort, dir } */
  var prefs = { view: "icon", sort: "manual", dir: "desc" };
  /** 当前分类页签 */
  var activeCat = CAT_ALL;
  /** 当前过滤词（搜索框 + 子关键词共用） */
  var query = "";
  /** 当前右键菜单指向的条目 id */
  var menuItemId = null;
  /** 内联浮层的提交回调（null = 浮层未开） */
  var promptCommit = null;
  /** 宿主是否支持系统图标（旧宿主没有则纯字形回退） */
  var canFileIcons = !!(ms.input && typeof ms.input.fileIcons === "function");
  /** 宿主是否支持受控打开（旧宿主没有则直接走 openExternal） */
  var canInputOpen = !!(ms.input && typeof ms.input.open === "function");
  /** 本次会话里**已被宿主登记**的路径（拖入/粘贴产生）→ 可走 ms.input.* */
  var registered = {};
  /** 路径 → 宿主给出的类型提示（"file" / "folder"；来自 ms.input.attachments） */
  var kindHints = {};
  /** 本次会话里已尝试过系统图标、但没拿到的路径（避免反复请求） */
  var iconMissed = {};
  /** 图标存储预算的已用字节 */
  var iconBytes = 0;

  /**
   * 本实例是否仍然是「当前活着的那个」。
   *
   * 为什么要判：`closeBehavior: minimize` 下关闭界面只是把 DOM 停靠保活，
   * 脚本**不重跑**；但插件被禁用/卸载/热重载后重新挂载时，会**再执行一次**
   * 本脚本——而 `document` 上挂的监听器（mousedown / ms-dropped-paths /
   * ms-attachments-changed）不会随旧 DOM 消失，老实例会跟着新实例一起响应
   * （表现为「一次拖入固定两遍」）。因此每个 document 级回调都先自检。
   */
  function isAlive() {
    return !!(rootEl && rootEl.isConnected && document.getElementById("app") === rootEl);
  }

  // ===== 工具 =====
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  /** 路径归一化（用于去重与登记判定；Windows 大小写不敏感） */
  function normPath(p) {
    return String(p == null ? "" : p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /** 取末级名字 */
  function baseName(p) {
    var s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /** 取父目录（无父目录返回空串） */
  function dirName(p) {
    var s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i > 0 ? s.slice(0, i) : "";
  }

  /** 取小写扩展名（无扩展名返回空串） */
  function extOf(name) {
    var s = String(name == null ? "" : name);
    var i = s.lastIndexOf(".");
    if (i <= 0 || i === s.length - 1) return "";
    return s.slice(i + 1).toLowerCase();
  }

  /** 条目 → 字形 key */
  function glyphKeyOf(entry) {
    if (entry.kind === "folder") return "folder";
    var ext = extOf(entry.name);
    return EXT_GLYPH[ext] || "file";
  }

  /** 字形 key → 内联 SVG（16x16 viewBox） */
  function glyphSvg(entry) {
    var key = glyphKeyOf(entry);
    var path = GLYPHS[key] || GLYPHS.file;
    return '<svg class="ml-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
      path + "</svg>";
  }

  /** 唯一 id（不依赖 crypto：老 WebView 也可能没有 randomUUID） */
  var uidSeq = 0;
  function uid() {
    uidSeq += 1;
    return "i" + Date.now().toString(36) + uidSeq.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  /** 时间格式化（列表视图的「添加时间」列） */
  function fmtTime(ms_) {
    var n = Number(ms_);
    if (!isFinite(n) || n <= 0) return "";
    var d = new Date(n);
    if (isNaN(d.getTime())) return "";
    var pad = function (x) { return String(x).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /** 状态行：只承载异常/过程消息，空文本 = 整行隐藏（不占一行空白） */
  var statusTimer = 0;
  function setStatus(text, kind, autoHideMs) {
    var el = dom["ml-status"];
    if (!el) return;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
    el.textContent = text || "";
    el.className = "ml-status" + (kind ? " is-" + kind : "");
    el.hidden = !text;
    if (text && autoHideMs) {
      statusTimer = setTimeout(function () {
        statusTimer = 0;
        el.textContent = "";
        el.hidden = true;
      }, autoHideMs);
    }
  }

  /** 提示（需 ui.notify；未授予时静默——DOM 内已有可见反馈） */
  function toast(text, kind) {
    try {
      if (ms.ui && typeof ms.ui.toast === "function") ms.ui.toast(String(text), kind === "err" ? "error" : "ok");
    } catch (e) { /* 未授予 ui.notify：忽略 */ }
  }

  function logw() {
    try {
      if (typeof ms.log === "function") ms.log.apply(null, ["warn"].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* ignore */ }
  }

  // ===== 持久化 =====

  /** 分类名规范化（去首尾空白、压缩内部空白、截断） */
  function cleanCatName(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 24);
  }

  /** 从 store 读取；容错脏数据（坏条目静默丢弃），并做一次轻量迁移 */
  function load() {
    var raw;
    try {
      raw = ms.store.get(STORE_KEY, null);
    } catch (e) {
      setStatus("读取本地数据失败：" + ((e && e.message) || e), "err");
      return;
    }
    if (!raw) return;

    // 早期/异常形态：直接存数组（无 version 包装）
    var data = Array.isArray(raw) ? { items: raw } : raw;
    if (!data || typeof data !== "object") return;

    var seen = {};
    var list = Array.isArray(data.items) ? data.items : [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || typeof it !== "object") continue;
      var path = String(it.path == null ? "" : it.path).trim();
      if (!path) continue;
      var key = normPath(path);
      if (seen[key]) continue;
      seen[key] = true;
      var name = String(it.name == null ? "" : it.name).trim() || baseName(path);
      var entry = {
        id: typeof it.id === "string" && it.id ? it.id : uid(),
        path: path,
        name: name,
        kind: it.kind === "folder" ? "folder" : "file",
        cat: typeof it.cat === "string" && it.cat ? it.cat : CAT_DEFAULT,
        createdAt: isFinite(Number(it.createdAt)) && Number(it.createdAt) > 0 ? Number(it.createdAt) : Date.now(),
      };
      var custom = String(it.customName == null ? "" : it.customName).trim();
      if (custom) entry.customName = custom.slice(0, 80);
      var icon = typeof it.icon === "string" ? it.icon : "";
      if (icon.indexOf("data:image/") === 0 && icon.length <= ICON_MAX_ONE) {
        entry.icon = icon;
        iconBytes += icon.length;
      }
      items.push(entry);
    }

    var catList = Array.isArray(data.cats) ? data.cats : [];
    var catSeen = {};
    catSeen[CAT_DEFAULT] = true;
    for (var c = 0; c < catList.length; c++) {
      var cc = catList[c];
      if (!cc || typeof cc !== "object") continue;
      var cid = typeof cc.id === "string" ? cc.id : "";
      var cname = cleanCatName(cc.name);
      if (!cid || !cname || catSeen[cid]) continue;
      catSeen[cid] = true;
      cats.push({ id: cid, name: cname });
    }
    // 条目指向了不存在的分类 → 归回默认分类（避免条目「消失」在无页签的分类里）
    var known = {};
    known[CAT_DEFAULT] = true;
    for (var k = 0; k < cats.length; k++) known[cats[k].id] = true;
    for (var j = 0; j < items.length; j++) {
      if (!known[items[j].cat]) items[j].cat = CAT_DEFAULT;
    }

    var p = data.prefs && typeof data.prefs === "object" ? data.prefs : {};
    prefs.view = p.view === "list" ? "list" : "icon";
    prefs.sort = ["manual", "created", "name", "type"].indexOf(p.sort) >= 0 ? p.sort : "manual";
    prefs.dir = p.dir === "asc" ? "asc" : "desc";
  }

  /** 落盘（minimize 保活时脚本不重跑，写入必须即时完成） */
  function save() {
    try {
      ms.store.set(STORE_KEY, {
        version: SCHEMA_VERSION,
        items: items,
        cats: cats,
        prefs: prefs,
      });
      return true;
    } catch (e) {
      setStatus("保存失败（本地存储可能已满）：" + ((e && e.message) || e), "err");
      return false;
    }
  }

  /** 图标存储预算控制：超预算时从**最旧**的条目开始丢图标（条目本身保留） */
  function trimIcons() {
    if (iconBytes <= ICON_BUDGET) return;
    var ordered = items.slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
    for (var i = 0; i < ordered.length && iconBytes > ICON_BUDGET; i++) {
      var it = ordered[i];
      if (!it.icon) continue;
      iconBytes -= it.icon.length;
      delete it.icon;
    }
  }

  // ===== 变更（全部走这里：改状态 → 落盘 → 重绘） =====

  function commit() {
    trimIcons();
    save();
    render();
  }

  /** 是否已固定该路径 */
  function findByPath(path) {
    var key = normPath(path);
    for (var i = 0; i < items.length; i++) if (normPath(items[i].path) === key) return items[i];
    return null;
  }

  function findById(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  /**
   * 探测路径是文件还是文件夹。
   *
   * 三级来源（越靠前越准、越便宜）：
   *   1. `kindHints` —— 宿主 `ms.input.attachments()` 直接给出的 `kind`
   *      （"file" / "folder"），最可靠；
   *   2. `ms.input.listFolder(path, { limit: 1 })` —— 它要求路径落在**已登记的
   *      文件夹**之下（Rust 侧 `require_folder=true`），因此**成功 ⇔ 是文件夹**；
   *   3. 名称启发式（无扩展名更像文件夹）。
   *
   * 失败不阻断固定：类型只影响字形与「定位」的降级方式，不影响能否打开。
   */
  function probeKind(path) {
    var hint = kindHints[normPath(path)];
    if (hint === "folder" || hint === "file") return Promise.resolve(hint);
    if (!ms.input || typeof ms.input.listFolder !== "function") {
      return Promise.resolve(guessKindByName(path));
    }
    return Promise.resolve(ms.input.listFolder(path, { limit: 1 }))
      .then(function () { return "folder"; })
      .catch(function () { return guessKindByName(path); });
  }

  /** 无可用探针时的名称启发式：无扩展名更像文件夹 */
  function guessKindByName(path) {
    return extOf(baseName(path)) ? "file" : "folder";
  }

  /**
   * 固定一批路径（拖入 / 搜索框附件 / 添加按钮共用）。
   *
   * 已固定过的路径**跳过**（不重复、不改动用户已有的重命名与分类）。
   * 类型探测与图标抓取都在**固定那一刻**做——此时路径刚被宿主登记，
   * `ms.input.*` 可用；图标字节随之持久化，重启后仍能显示。
   */
  function addPaths(paths, catId) {
    var list = [];
    var dup = 0;
    for (var i = 0; i < (paths || []).length; i++) {
      var p = String(paths[i] == null ? "" : paths[i]).trim();
      if (!p) continue;
      registered[normPath(p)] = true;
      if (findByPath(p)) { dup++; continue; }
      list.push(p);
    }
    if (list.length === 0) {
      if (dup > 0) setStatus("这 " + dup + " 项已经在固定列表里了", "warn", 2600);
      return Promise.resolve(0);
    }
    var targetCat = catId && catId !== CAT_ALL ? catId : activeCat;
    if (targetCat === CAT_ALL) targetCat = CAT_DEFAULT;

    return Promise.all(list.map(function (p) {
      return probeKind(p).then(function (kind) {
        return { path: p, kind: kind };
      });
    })).then(function (probed) {
      var now = Date.now();
      var added = [];
      for (var j = 0; j < probed.length; j++) {
        var e = {
          id: uid(),
          path: probed[j].path,
          name: baseName(probed[j].path),
          kind: probed[j].kind,
          cat: targetCat,
          createdAt: now + j, // 同一批保持稳定顺序
        };
        items.push(e);
        added.push(e);
      }
      commit();
      // 图标：失败不影响固定（退回字形），因此单独一步、不阻塞上面的提交
      return fetchIcons(added).then(function () {
        commit();
        return added.length;
      });
    }).then(function (n) {
      var extra = dup > 0 ? "（" + dup + " 项已存在，已跳过）" : "";
      setStatus("已固定 " + n + " 项" + extra, "ok", 2600);
      toast("已固定 " + n + " 项");
      return n;
    });
  }

  /** 移除一个条目 */
  function removeItem(id) {
    var before = items.length;
    items = items.filter(function (it) { return it.id !== id; });
    if (items.length === before) return;
    commit();
  }

  /** 重命名（空串 = 恢复为文件名） */
  function renameItem(id, next) {
    var it = findById(id);
    if (!it) return;
    var name = String(next == null ? "" : next).replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name || name === it.name) delete it.customName;
    else it.customName = name;
    commit();
  }

  /** 移动到分类 */
  function moveToCat(id, catId) {
    var it = findById(id);
    if (!it || !catId) return;
    if (it.cat === catId) return;
    it.cat = catId;
    commit();
  }

  /** 手动排序：把条目相对邻居移动（dir = -1 上移 / 1 下移 / 0 置顶） */
  function reorderItem(id, dir) {
    var it = findById(id);
    if (!it) return;
    // 只在同一分类内调整：先取出该分类的手动顺序数组
    var peers = items.filter(function (x) { return x.cat === it.cat; });
    var idx = peers.indexOf(it);
    if (idx < 0) return;
    var target;
    if (dir === 0) target = 0;
    else target = idx + (dir < 0 ? -1 : 1);
    if (target < 0 || target >= peers.length || target === idx) return;
    peers.splice(idx, 1);
    peers.splice(target, 0, it);
    // 用 createdAt 承载手动顺序（手动排序下按它排），保持一个稳定的可持久化序列
    var base = Date.now() - peers.length * 1000;
    for (var i = 0; i < peers.length; i++) peers[i].createdAt = base + i * 1000;
    // 切到手动排序，否则刚调整的顺序会被其它排序键盖掉
    prefs.sort = "manual";
    prefs.dir = "asc";
    commit();
  }

  /** 新建分类（返回新分类 id；名字重复时返回已有的） */
  function addCat(name) {
    var clean = cleanCatName(name);
    if (!clean) return null;
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].name === clean) return cats[i].id;
    }
    var c = { id: "c" + uid(), name: clean };
    cats.push(c);
    commit();
    return c.id;
  }

  function renameCat(id, name) {
    var clean = cleanCatName(name);
    if (!clean) return;
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].id === id) {
        if (cats[i].name === clean) return;
        cats[i].name = clean;
        commit();
        return;
      }
    }
  }

  /** 删除分类：其中条目归回默认分类（不删条目——用户没说要删数据） */
  function delCat(id) {
    var before = cats.length;
    cats = cats.filter(function (c) { return c.id !== id; });
    if (cats.length === before) return;
    for (var i = 0; i < items.length; i++) if (items[i].cat === id) items[i].cat = CAT_DEFAULT;
    if (activeCat === id) activeCat = CAT_ALL;
    commit();
  }

  // ===== 图标 =====

  /** 批量抓取系统图标并挂到条目上（只对**本次已登记**的路径有效） */
  function fetchIcons(entries) {
    if (!canFileIcons) return Promise.resolve(0);
    var need = [];
    for (var i = 0; i < (entries || []).length; i++) {
      var it = entries[i];
      if (!it || it.icon) continue;
      if (iconMissed[normPath(it.path)]) continue;
      need.push(it);
    }
    if (need.length === 0) return Promise.resolve(0);
    // 分批请求：Rust 侧任一越界路径会**整批拒绝**，所以先按「已登记」筛一遍，
    // 再把可能越界的路径单独试，避免一个失效项拖垮整批图标。
    var ok = [], maybe = [];
    for (var j = 0; j < need.length; j++) {
      if (registered[normPath(need[j].path)]) ok.push(need[j]);
      else maybe.push(need[j]);
    }
    var tasks = [];
    if (ok.length) tasks.push(iconBatch(ok));
    for (var m = 0; m < maybe.length; m++) tasks.push(iconBatch([maybe[m]]));
    // 返回**实际抓到的条数**：调用方据此决定要不要重绘（曾漏返回，导致
    // 初始化时图标挂到了数据上、界面却一直显示字形，直到下次交互才刷新）。
    return Promise.all(tasks).then(function (counts) {
      var total = 0;
      for (var k = 0; k < counts.length; k++) total += counts[k] || 0;
      return total;
    });
  }

  /** 一批图标请求（路径不在登记集合内时整批失败——调用方负责分批策略） */
  function iconBatch(batch) {
    var req = batch.map(function (it) { return { path: it.path, isDir: it.kind === "folder" }; });
    return Promise.resolve(ms.input.fileIcons(req)).then(function (map) {
      var got = 0;
      for (var i = 0; i < batch.length; i++) {
        var url = map && map[batch[i].path];
        if (typeof url === "string" && url.indexOf("data:image/") === 0 && url.length <= ICON_MAX_ONE) {
          batch[i].icon = url;
          iconBytes += url.length;
          got++;
        } else {
          iconMissed[normPath(batch[i].path)] = true;
        }
      }
      return got;
    }).catch(function (e) {
      // 整批被拒（多半是路径不在登记集合内）：标记不再重试，退回字形
      for (var i = 0; i < batch.length; i++) iconMissed[normPath(batch[i].path)] = true;
      logw("取系统图标失败（退回内置字形）:", (e && e.message) || e);
      return 0;
    });
  }

  // ===== 打开 / 定位 / 复制 =====

  /**
   * 打开一个固定项。三层降级（详见文件头注释）：
   *   1. 已登记路径 → `ms.input.open`（文档化、受权限与集合双重校验）；
   *   2. 其余（跨会话的固定项）→ 宿主注入的 `openExternal`（本地路径交系统默认程序）；
   *   3. 都不行 → 明确报错，不静默。
   */
  function openEntry(entry) {
    if (!entry || !entry.path) return Promise.resolve(false);
    var path = entry.path;
    var isReg = !!registered[normPath(path)];

    function viaExternal() {
      if (typeof openExternal === "function") {
        return Promise.resolve(openExternal(path)).then(function () { return true; });
      }
      return Promise.reject(new Error("当前宿主不支持打开本地文件"));
    }

    var first = isReg && canInputOpen
      ? Promise.resolve(ms.input.open(path)).then(function () { return true; })
      : viaExternal();

    return first.catch(function (e) {
      // ms.input.open 被拒（路径不在集合内 / 已失效）→ 退到 openExternal
      if (isReg && canInputOpen) return viaExternal();
      throw e;
    }).catch(function (e) {
      var msg = (e && e.message) || e || "未知错误";
      setStatus("打开失败：" + msg + "（文件可能已被移动或删除，可在右键菜单里移除）", "err");
      logw("打开失败:", path, msg);
      return false;
    });
  }

  /**
   * 在资源管理器中定位。
   *   1. 已登记 → `ms.input.reveal`（打开所在目录并**选中**该条目）；
   *   2. 否则降级为打开所在目录（`openExternal(parentDir)`）——跨会话时拿不到
   *      「选中」语义（宿主只对已登记路径提供），但至少落在正确的目录里。
   */
  function revealEntry(entry) {
    if (!entry || !entry.path) return Promise.resolve(false);
    var path = entry.path;
    var isReg = !!registered[normPath(path)];
    if (isReg && ms.input && typeof ms.input.reveal === "function") {
      return Promise.resolve(ms.input.reveal(path)).then(function () { return true; }).catch(function () {
        return openParentDir(entry);
      });
    }
    return openParentDir(entry);
  }

  function openParentDir(entry) {
    var dir = dirName(entry.path);
    // 文件夹本身的「定位」= 打开它自己
    var target = entry.kind === "folder" ? entry.path : dir;
    if (!target) return Promise.resolve(false);
    if (typeof openExternal !== "function") return Promise.resolve(false);
    return Promise.resolve(openExternal(target)).then(function () { return true; }).catch(function (e) {
      setStatus("定位失败：" + ((e && e.message) || e), "err");
      return false;
    });
  }

  /** 复制路径到剪贴板（需要 clipboard.write；未授予时给出可读提示） */
  function copyPath(entry) {
    if (!entry) return Promise.resolve(false);
    var text = entry.path;
    var write = (ms.system && typeof ms.system.writeClipboard === "function")
      ? function () { return ms.system.writeClipboard(text); }
      : null;
    if (!write) {
      // 降级：navigator.clipboard 在 WebView 里通常也可用（且不需要插件权限）
      if (navigator.clipboard && navigator.clipboard.writeText) {
        write = function () { return navigator.clipboard.writeText(text); };
      }
    }
    if (!write) {
      setStatus("复制失败：缺少剪贴板权限", "err");
      return Promise.resolve(false);
    }
    return Promise.resolve(write()).then(function () {
      setStatus("已复制路径：" + text, "ok", 2200);
      toast("已复制路径");
      return true;
    }).catch(function (e) {
      setStatus("复制失败：" + ((e && e.message) || e), "err");
      return false;
    });
  }

  // ===== 渲染 =====

  /** 条目的展示名（自定义名优先） */
  function displayName(it) {
    return it.customName || it.name || baseName(it.path);
  }

  /** 当前分类 + 过滤词下的可见条目（按 prefs 排序） */
  function visibleItems() {
    var list = items.filter(function (it) {
      if (activeCat !== CAT_ALL && it.cat !== activeCat) return false;
      if (!query) return true;
      var hay = (displayName(it) + "\n" + it.path).toLowerCase();
      // 空格分词 AND 语义：多个词都要命中
      var words = query.toLowerCase().split(/\s+/);
      for (var i = 0; i < words.length; i++) {
        if (words[i] && hay.indexOf(words[i]) < 0) return false;
      }
      return true;
    });

    var dir = prefs.dir === "asc" ? 1 : -1;
    if (prefs.sort === "manual") {
      // 手动顺序：createdAt 升序即用户调整后的顺序（reorderItem 用 createdAt 承载）
      list.sort(function (a, b) { return a.createdAt - b.createdAt; });
      if (prefs.dir === "desc") list.reverse();
    } else if (prefs.sort === "created") {
      list.sort(function (a, b) { return (a.createdAt - b.createdAt) * dir; });
    } else if (prefs.sort === "name") {
      list.sort(function (a, b) {
        return displayName(a).localeCompare(displayName(b), "zh-Hans-CN", { numeric: true }) * dir;
      });
    } else if (prefs.sort === "type") {
      list.sort(function (a, b) {
        var ka = glyphKeyOf(a), kb = glyphKeyOf(b);
        if (ka !== kb) return ka < kb ? -dir : dir;
        return displayName(a).localeCompare(displayName(b), "zh-Hans-CN", { numeric: true }) * dir;
      });
    }
    return list;
  }

  /** 统计行（常驻；0 项也照常显示） */
  function renderStats(list) {
    var el = dom["ml-stats"];
    if (!el) return;
    var total = items.length;
    var parts = [];
    parts.push("共 " + total + " 项");
    if (activeCat !== CAT_ALL || query) parts.push("当前显示 " + list.length + " 项");
    var folders = 0;
    for (var i = 0; i < items.length; i++) if (items[i].kind === "folder") folders++;
    parts.push("文件夹 " + folders + " · 文件 " + (total - folders));
    if (query) parts.push("过滤「" + query + "」");
    el.textContent = parts.join(" · ");
  }

  /** 分类页签（「全部」恒在；每个页签带当前数据下的条目数） */
  function renderTabs() {
    var el = dom["ml-tabs"];
    if (!el) return;
    var counts = {};
    counts[CAT_ALL] = items.length;
    counts[CAT_DEFAULT] = 0;
    for (var c = 0; c < cats.length; c++) counts[cats[c].id] = 0;
    for (var i = 0; i < items.length; i++) {
      var cid = items[i].cat;
      counts[cid] = (counts[cid] || 0) + 1;
    }
    var html = tabHtml(CAT_ALL, "全部", counts[CAT_ALL] || 0);
    html += tabHtml(CAT_DEFAULT, "未分类", counts[CAT_DEFAULT] || 0);
    for (var j = 0; j < cats.length; j++) {
      html += tabHtml(cats[j].id, cats[j].name, counts[cats[j].id] || 0);
    }
    html += '<button class="ml-tab ml-tab-add" type="button" data-act="new-cat" title="新建分类">+ 分类</button>';
    el.innerHTML = html;
  }

  function tabHtml(id, name, count) {
    var active = activeCat === id ? " is-active" : "";
    return '<button class="ml-tab' + active + '" type="button" role="tab" data-cat="' + esc(id) +
      '" title="' + esc(name) + '（右键管理）">' + esc(name) +
      ' <span class="ml-tab-num">' + count + "</span></button>";
  }

  /** 排序栏（按钮高亮 + 方向箭头） */
  function renderSortbar() {
    var el = dom["ml-sort"];
    if (!el) return;
    var btns = el.querySelectorAll(".ml-sort-btn");
    for (var i = 0; i < btns.length; i++) {
      var s = btns[i].getAttribute("data-sort");
      if (s === prefs.sort) btns[i].classList.add("active");
      else btns[i].classList.remove("active");
    }
    var dirBtn = dom["ml-sort-dir"];
    if (dirBtn) {
      dirBtn.textContent = prefs.dir === "asc" ? "↑" : "↓";
      dirBtn.title = prefs.dir === "asc" ? "当前升序，点击切换为降序" : "当前降序，点击切换为升序";
    }
    // 手动排序下方向按钮仍可用（整体反转），但提示文案更准确
    var viewBtns = dom["ml-viewmode"] ? dom["ml-viewmode"].querySelectorAll(".ml-seg-btn") : [];
    for (var v = 0; v < viewBtns.length; v++) {
      if (viewBtns[v].getAttribute("data-view") === prefs.view) viewBtns[v].classList.add("is-active");
      else viewBtns[v].classList.remove("is-active");
    }
  }

  /** 条目行（图标视图 / 列表视图共用一份数据，样式由容器 class 决定） */
  function rowHtml(it) {
    var label = displayName(it);
    var renamed = !!it.customName;
    var catName = catNameOf(it.cat);
    var iconHtml;
    if (it.icon) {
      iconHtml = '<img class="ml-icon-img" src="' + esc(it.icon) + '" alt="" aria-hidden="true" draggable="false">';
    } else {
      iconHtml = glyphSvg(it);
    }
    var meta = [];
    if (prefs.view === "list") {
      meta.push(catName);
      meta.push(it.kind === "folder" ? "文件夹" : (extOf(it.name) || "文件"));
      meta.push(fmtTime(it.createdAt));
    }
    return '<div class="ml-item" role="listitem" data-id="' + esc(it.id) + '"' +
      ' title="' + esc(it.path) + '" tabindex="0">' +
      '<span class="ml-item-icon">' + iconHtml + "</span>" +
      '<span class="ml-item-body">' +
        '<span class="ml-item-name">' + esc(label) +
          (renamed ? '<span class="ml-badge" title="已重命名">改</span>' : "") +
        "</span>" +
        '<span class="ml-item-path">' + esc(it.path) + "</span>" +
        (meta.length
          ? '<span class="ml-item-meta">' + esc(meta.join(" · ")) + "</span>"
          : "") +
      "</span>" +
      '<span class="ml-item-acts">' +
        '<button class="ml-icon-btn" type="button" data-act="open" data-id="' + esc(it.id) +
          '" title="打开" aria-label="打开">打开</button>' +
        '<button class="ml-icon-btn" type="button" data-act="reveal" data-id="' + esc(it.id) +
          '" title="在资源管理器中定位" aria-label="定位">定位</button>' +
      "</span>" +
      "</div>";
  }

  function catNameOf(id) {
    if (id === CAT_DEFAULT) return "未分类";
    for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i].name;
    return "未分类";
  }

  function render() {
    if (!isAlive()) return;
    var list = visibleItems();
    renderStats(list);
    renderTabs();
    renderSortbar();

    var listEl = dom["ml-list"];
    if (listEl) {
      listEl.className = "ml-list is-" + prefs.view;
      // 行数上限：极大列表（几百项）不做虚拟滚动，但限制渲染量避免卡顿
      var RENDER_LIMIT = 500;
      var shown = list.slice(0, RENDER_LIMIT);
      listEl.innerHTML = shown.map(rowHtml).join("");
      listEl.hidden = shown.length === 0;
    }

    var emptyEl = dom["ml-empty"];
    if (emptyEl) {
      var empty = list.length === 0;
      emptyEl.hidden = !empty;
      if (empty) {
        var textEl = dom["ml-empty-text"];
        var hintEl = dom["ml-empty-hint"];
        if (items.length === 0) {
          if (textEl) textEl.textContent = "还没有固定项";
          if (hintEl) hintEl.textContent = "把文件或文件夹拖到本界面，或用上面的「添加」按钮";
        } else if (query) {
          if (textEl) textEl.textContent = "没有匹配「" + query + "」的固定项";
          if (hintEl) hintEl.textContent = "换个关键词，或点右侧 × 清除过滤";
        } else {
          if (textEl) textEl.textContent = "这个分类下还没有固定项";
          if (hintEl) hintEl.textContent = "拖入文件即固定到「" + catNameOf(activeCat) + "」，或在右键菜单里移动条目";
        }
      }
    }

    // 过滤框的清除按钮
    var clearBtn = dom["ml-search-clear"];
    if (clearBtn) clearBtn.hidden = !query;

    var searchEl = dom["ml-search"];
    if (searchEl && searchEl.value !== query) searchEl.value = query;
  }

  // ===== 右键菜单 =====

  function closeMenu() {
    menuItemId = null;
    if (dom["ml-menu"]) {
      dom["ml-menu"].hidden = true;
      dom["ml-menu"].innerHTML = "";
    }
  }

  function openMenu(it, x, y) {
    var el = dom["ml-menu"];
    if (!el || !it) return;
    menuItemId = it.id;
    var html = "";
    html += menuRow("open", "打开");
    html += menuRow("reveal", "在资源管理器中定位");
    html += menuRow("copy", "复制路径");
    html += '<div class="ml-menu-sep"></div>';
    html += menuRow("rename", "重命名…");
    if (prefs.sort === "manual") {
      html += menuRow("top", "置顶");
      html += menuRow("up", "上移");
      html += menuRow("down", "下移");
    }
    html += '<div class="ml-menu-sep"></div>';
    html += '<div class="ml-menu-label">移动到分类</div>';
    html += menuRow("cat:" + CAT_DEFAULT, "未分类" + (it.cat === CAT_DEFAULT ? " ✓" : ""));
    for (var i = 0; i < cats.length; i++) {
      html += menuRow("cat:" + cats[i].id, esc(cats[i].name) + (it.cat === cats[i].id ? " ✓" : ""));
    }
    html += menuRow("new-cat-move", "+ 新建分类并移入…");
    html += '<div class="ml-menu-sep"></div>';
    html += menuRow("remove", "从固定列表移除");
    el.innerHTML = html;
    el.hidden = false;

    // 定位到鼠标处，并夹紧在视口内（菜单可能贴到窗口右下角）
    var rect = el.getBoundingClientRect();
    var left = Math.max(4, Math.min(x, (window.innerWidth || 800) - rect.width - 4));
    var top = Math.max(4, Math.min(y, (window.innerHeight || 600) - rect.height - 4));
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function menuRow(act, label) {
    return '<button class="ml-menu-item" type="button" role="menuitem" data-act="' +
      esc(act) + '">' + label + "</button>";
  }

  // ===== 内联浮层（重命名 / 新建分类：宿主只提供 confirm，没有文本输入） =====

  function openPrompt(opts) {
    var el = dom["ml-prompt"];
    if (!el) return;
    var titleEl = dom["ml-prompt-title"];
    var inputEl = dom["ml-prompt-input"];
    if (titleEl) titleEl.textContent = opts.title || "输入";
    if (inputEl) {
      inputEl.value = opts.value || "";
      inputEl.placeholder = opts.placeholder || "";
      inputEl.maxLength = opts.maxLength || 80;
    }
    promptCommit = opts.commit || null;
    el.hidden = false;
    if (inputEl) {
      // 等浮层可见后再聚焦，否则部分 WebView 下聚焦会被忽略
      setTimeout(function () {
        try { inputEl.focus(); inputEl.select(); } catch (e) { /* ignore */ }
      }, 0);
    }
  }

  function closePrompt() {
    promptCommit = null;
    if (dom["ml-prompt"]) dom["ml-prompt"].hidden = true;
  }

  function commitPrompt() {
    var fn = promptCommit;
    var value = dom["ml-prompt-input"] ? dom["ml-prompt-input"].value : "";
    closePrompt();
    if (typeof fn === "function") fn(value);
  }

  // ===== 交互 =====

  /** 记住宿主对一批附件的类型提示（最准的类型来源，见 probeKind） */
  function rememberKinds(list) {
    for (var i = 0; i < (list || []).length; i++) {
      var a = list[i];
      if (!a || !a.path) continue;
      registered[normPath(a.path)] = true;
      if (a.kind === "file" || a.kind === "folder") kindHints[normPath(a.path)] = a.kind;
    }
  }

  /** 点击「添加」：优先固定搜索框里已附加的文件/文件夹；没有则给出指引 */
  function addFromAttachments() {
    if (!ms.input || typeof ms.input.attachments !== "function") {
      setStatus("当前宿主不支持读取附件；请直接把文件/文件夹拖到本界面", "warn", 4000);
      return;
    }
    Promise.resolve(ms.input.attachments()).then(function (list) {
      rememberKinds(list);
      var paths = [];
      for (var i = 0; i < (list || []).length; i++) {
        var a = list[i];
        if (a && a.path) paths.push(a.path);
      }
      if (paths.length === 0) {
        setStatus("搜索框里还没有文件/文件夹。把文件拖到本界面即可固定，也可以先粘进搜索框再点「添加」", "warn", 5200);
        return;
      }
      return addPaths(paths);
    }).catch(function (e) {
      setStatus("读取附件失败：" + ((e && e.message) || e), "err");
    });
  }

  /** 处理一个条目操作（点击 / 菜单共用） */
  function handleItemAct(act, id) {
    var it = findById(id);
    if (!it) return;
    if (act === "open") { closeMenu(); void openEntry(it); return; }
    if (act === "reveal") { closeMenu(); void revealEntry(it); return; }
    if (act === "copy") { closeMenu(); void copyPath(it); return; }
    if (act === "rename") {
      closeMenu();
      openPrompt({
        title: "重命名（留空恢复为文件名）",
        value: displayName(it),
        placeholder: it.name,
        maxLength: 80,
        commit: function (v) { renameItem(id, v); },
      });
      return;
    }
    if (act === "top") { reorderItem(id, 0); closeMenu(); return; }
    if (act === "up") { reorderItem(id, -1); closeMenu(); return; }
    if (act === "down") { reorderItem(id, 1); closeMenu(); return; }
    if (act === "remove") { removeItem(id); closeMenu(); return; }
    if (act.indexOf("cat:") === 0) { moveToCat(id, act.slice(4)); closeMenu(); return; }
    if (act === "new-cat-move") {
      closeMenu();
      openPrompt({
        title: "新建分类并移入",
        value: "",
        placeholder: "分类名（如：工作 / 设计稿）",
        maxLength: 24,
        commit: function (v) {
          var cid = addCat(v);
          if (cid) moveToCat(id, cid);
        },
      });
      return;
    }
  }

  function onListClick(e) {
    var btn = e.target.closest ? e.target.closest("[data-act]") : null;
    if (btn && btn.getAttribute) {
      var act = btn.getAttribute("data-act");
      var id = btn.getAttribute("data-id");
      if (act && id) { handleItemAct(act, id); return; }
    }
    // 点行其余区域 = 打开（与 Maye Lite 的「双击运行」对应；这里单击即打开更省事）
    var row = e.target.closest ? e.target.closest(".ml-item") : null;
    if (row) {
      var rid = row.getAttribute("data-id");
      if (rid) handleItemAct("open", rid);
    }
  }

  function onListContext(e) {
    var row = e.target.closest ? e.target.closest(".ml-item") : null;
    if (!row) { closeMenu(); return; }
    e.preventDefault();
    var id = row.getAttribute("data-id");
    var it = findById(id);
    if (!it) return;
    openMenu(it, e.clientX, e.clientY);
  }

  /** 键盘：Enter 打开焦点行；Esc 关菜单/浮层/清过滤 */
  function onKeydown(e) {
    if (e.key === "Escape") {
      if (dom["ml-prompt"] && !dom["ml-prompt"].hidden) { closePrompt(); e.preventDefault(); return; }
      if (dom["ml-menu"] && !dom["ml-menu"].hidden) { closeMenu(); e.preventDefault(); return; }
      if (query) { setQuery(""); e.preventDefault(); }
      return;
    }
    if (e.key === "Enter") {
      var row = e.target.closest ? e.target.closest(".ml-item") : null;
      if (row) {
        e.preventDefault();
        handleItemAct("open", row.getAttribute("data-id"));
      }
    }
  }

  function setQuery(q) {
    query = String(q == null ? "" : q).slice(0, QUERY_MAX);
    render();
  }

  /** 宿主转发子关键词（「快速启动 : 关键词」）→ 作为过滤词 */
  if (typeof onSubKeyword === "function") {
    onSubKeyword(function (msg) {
      setQuery(msg);
      return true;
    });
  }

  /* ======================= 全局快捷键动作（宿主转发） =======================
   *
   * 清单 contributes.shortcut 里声明了本地动作名 `open`；宿主把它注册成全局热键
   * （`plugin:com.my-search.mayelite:open`，默认 `Ctrl+Alt+B`），按下后打开本视图
   * 并把动作名派发到这里。行为：把焦点落到顶部过滤框，用户即可**直接输入关键词**
   * 过滤固定项 → 回车 / 单击打开目标，一键直达（与 Maye Lite 的呼出体验一致）。
   *
   * 宿主的派发时机在视图已挂载/恢复之后（见 App.vue runPluginActionByShortcut），
   * 因此这里只管聚焦；minimize 保活恢复的场景 DOM 仍在，聚焦照常有效。
   */
  function focusFilter() {
    var searchEl = dom["ml-search"];
    if (!searchEl) return;
    try {
      searchEl.focus();
      searchEl.select();
    } catch (e) { /* ignore */ }
  }

  /**
   * 处理宿主派发的快捷键动作。只有 `open` 是这个插件认识的动作；
   * 其它名字（清单改版后新增）静默忽略——宿主对「没处理器」的场景会自行提示。
   */
  if (ms && ms.shortcuts && typeof ms.shortcuts.onAction === "function") {
    ms.shortcuts.onAction("open", function () {
      focusFilter();
    });
  }

  // ===== 事件绑定 =====
  (function bind() {
    var listEl = dom["ml-list"];
    if (listEl) {
      listEl.addEventListener("click", onListClick);
      listEl.addEventListener("contextmenu", onListContext);
      listEl.addEventListener("keydown", onKeydown);
    }

    var tabsEl = dom["ml-tabs"];
    if (tabsEl) {
      tabsEl.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-cat],[data-act]") : null;
        if (!btn) return;
        var act = btn.getAttribute("data-act");
        if (act === "new-cat") {
          openPrompt({
            title: "新建分类",
            value: "",
            placeholder: "分类名（如：工作 / 设计稿）",
            maxLength: 24,
            commit: function (v) { if (addCat(v)) activeCat = CAT_ALL; },
          });
          return;
        }
        var cid = btn.getAttribute("data-cat");
        if (cid) { activeCat = cid; closeMenu(); render(); }
      });
      // 分类页签右键：重命名 / 删除（「全部」「未分类」不可改）
      tabsEl.addEventListener("contextmenu", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-cat]") : null;
        if (!btn) return;
        var cid = btn.getAttribute("data-cat");
        if (cid === CAT_ALL || cid === CAT_DEFAULT) return;
        e.preventDefault();
        var el = dom["ml-menu"];
        if (!el) return;
        menuItemId = null;
        el.innerHTML = menuRow("cat-rename:" + cid, "重命名分类…") +
          menuRow("cat-del:" + cid, "删除分类（条目归入未分类）");
        el.hidden = false;
        var rect = el.getBoundingClientRect();
        el.style.left = Math.max(4, Math.min(e.clientX, (window.innerWidth || 800) - rect.width - 4)) + "px";
        el.style.top = Math.max(4, Math.min(e.clientY, (window.innerHeight || 600) - rect.height - 4)) + "px";
      });
    }

    var sortEl = dom["ml-sort"];
    if (sortEl) {
      sortEl.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-sort]") : null;
        if (btn) {
          var s = btn.getAttribute("data-sort");
          if (s) { prefs.sort = s; prefs.dir = s === "manual" ? "asc" : "desc"; commit(); }
          return;
        }
        if (e.target === dom["ml-sort-dir"]) {
          prefs.dir = prefs.dir === "asc" ? "desc" : "asc";
          commit();
        }
      });
    }

    var viewEl = dom["ml-viewmode"];
    if (viewEl) {
      viewEl.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-view]") : null;
        if (!btn) return;
        var v = btn.getAttribute("data-view");
        if (v && v !== prefs.view) { prefs.view = v; commit(); }
      });
    }

    if (dom["ml-add"]) dom["ml-add"].addEventListener("click", addFromAttachments);

    var searchEl = dom["ml-search"];
    if (searchEl) {
      searchEl.addEventListener("input", function () { setQuery(searchEl.value); });
      searchEl.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { setQuery(""); e.stopPropagation(); }
      });
    }
    if (dom["ml-search-clear"]) {
      dom["ml-search-clear"].addEventListener("click", function () { setQuery(""); });
    }

    // 菜单点击（菜单在 #app 内，单独绑在自己的节点上；分类管理项也走这里）
    var menuEl = dom["ml-menu"];
    if (menuEl) {
      menuEl.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-act]") : null;
        if (!btn) return;
        var act = btn.getAttribute("data-act") || "";
        if (act.indexOf("cat-rename:") === 0) {
          var cidR = act.slice(11);
          closeMenu();
          openPrompt({
            title: "重命名分类",
            value: catNameOf(cidR),
            maxLength: 24,
            commit: function (v) { renameCat(cidR, v); },
          });
          return;
        }
        if (act.indexOf("cat-del:") === 0) {
          var cidD = act.slice(8);
          closeMenu();
          delCat(cidD);
          setStatus("已删除分类，其中的条目归入「未分类」", "ok", 2600);
          return;
        }
        if (menuItemId) handleItemAct(act, menuItemId);
      });
    }

    // 浮层
    if (dom["ml-prompt-ok"]) dom["ml-prompt-ok"].addEventListener("click", commitPrompt);
    if (dom["ml-prompt-cancel"]) dom["ml-prompt-cancel"].addEventListener("click", closePrompt);
    var promptInput = dom["ml-prompt-input"];
    if (promptInput) {
      promptInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commitPrompt(); }
        else if (e.key === "Escape") { e.preventDefault(); closePrompt(); }
      });
    }

    // 点空白处关菜单/浮层（老实例自检：见 isAlive 的说明）
    document.addEventListener("mousedown", function (e) {
      if (!isAlive()) return;
      if (dom["ml-menu"] && !dom["ml-menu"].hidden) {
        if (!dom["ml-menu"].contains(e.target)) closeMenu();
      }
      if (dom["ml-prompt"] && !dom["ml-prompt"].hidden) {
        // 点浮层卡片外 = 取消
        var card = dom["ml-prompt"].querySelector(".ml-prompt-card");
        if (card && !card.contains(e.target)) closePrompt();
      }
    });

    /**
     * 宿主定向投递的拖入路径（`ms-dropped-paths`）。
     *
     * 必须订阅：主窗口开着 Tauri 原生拖放处理器，插件页里的 HTML5
     * `dragover/drop` **永远不会触发**，拖到本界面的文件只有这条路能拿到。
     * 宿主投递前已把路径登记给 Rust，因此 `ms.input.*` 对它们是可用的
     *（类型探测与图标抓取都靠这一点）。
     */
    document.addEventListener("ms-dropped-paths", function (e) {
      if (!isAlive()) return;
      var detail = (e && e.detail) || {};
      var paths = detail.paths || [];
      if (!paths.length) return;
      void addPaths(paths);
    });

    /**
     * 搜索框附件变化（粘贴/拖入/移除）。
     * 本插件不自动固定（用户没说要固定），只在有「尚未固定」的附件时
     * 提示一句，把「点添加即可固定」这条路径说清楚。
     */
    document.addEventListener("ms-attachments-changed", function () {
      if (!isAlive()) return;
      if (!ms.input || typeof ms.input.attachments !== "function") return;
      Promise.resolve(ms.input.attachments()).then(function (list) {
        rememberKinds(list);
        var fresh = 0;
        for (var i = 0; i < (list || []).length; i++) {
          var a = list[i];
          if (!a || !a.path) continue;
          if (!findByPath(a.path)) fresh++;
        }
        if (fresh > 0) {
          setStatus("搜索框里有 " + fresh + " 项还没固定，点右上角「添加」即可固定", "warn", 5200);
        }
      }).catch(function () { /* ignore */ });
    });
  })();

  // ===== 启动 =====
  load();
  render();

  // 初始化时的图标补抓：只对**已登记**路径有效（重启后通常拿不到，走字形回退）
  if (canFileIcons) {
    Promise.resolve(ms.input.attachments ? ms.input.attachments() : []).then(function (list) {
      rememberKinds(list);
      return fetchIcons(items);
    }).then(function (n) {
      if (n) commit();
    }).catch(function () { /* ignore */ });
  }

  try {
    if (typeof ms.log === "function") {
      ms.log("info", "MayeLite 快速启动已加载：固定 " + items.length + " 项 / " + cats.length + " 个分类");
    }
  } catch (e) { /* ignore */ }
})(
  ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html,
  typeof openExternal !== "undefined" ? openExternal : undefined
);