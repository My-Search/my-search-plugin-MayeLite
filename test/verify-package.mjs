/**
 * 发版前的本地校验：打包 + 用**宿主的安装预处理**复核产物。
 *
 * 用法:
 *   node test/verify-package.mjs
 *
 * 打包走仓库自带的 tools/pack-plugin.mjs（宿主同一份实现，见该文件注释），
 * 因此**不需要宿主仓库在场**；解包复核用的是 vendor 在 tools/host/ 的
 * `preparePackage`——它正是客户端安装时走的那一步。
 *
 * 校验链：
 *   1. 打包（清单校验 → 收集文件 → writeZip）；
 *   2. 解包 + 清单校验（id / 版本 / 权限白名单 / 入口文件存在）；
 *   3. 核对市场规范（tag = 插件 id、关键词可唤起、界面权限齐备）。
 *
 * 任一环失败即非零退出——别把装不上的包发出去。
 */
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = path.join(root, "tools");

const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
const outDir = path.join(root, "dist");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${manifest.id}.mspp`);

// ---- 1. 打包（用仓库自带的打包器；源目录用绝对路径，避免受 cwd 影响）----
console.log("[1/3] 打包…");
execFileSync("node", [path.join(toolsDir, "pack-plugin.mjs"), root, "-o", outFile], {
  cwd: root,
  stdio: "inherit",
});

// ---- 2. 解包校验（宿主的 preparePackage：与客户端安装同一条链路）----
console.log("\n[2/3] 解包校验（宿主 preparePackage）…");
const { preparePackage } = await import(
  pathToFileURL(path.join(toolsDir, "host", "install.ts")).href
);
const { isKnownPermission } = await import(
  pathToFileURL(path.join(toolsDir, "host", "permissions.ts")).href
);
const bytes = new Uint8Array(readFileSync(outFile));
const prep = await preparePackage(bytes, { checkPermissions: isKnownPermission });
console.log(`  插件：${prep.manifest.name} v${prep.manifest.version}（${prep.manifest.id}）`);
console.log(`  权限：${(prep.manifest.permissions ?? []).join(", ") || "（无）"}`);
if (prep.manifest.optionalPermissions?.length) {
  console.log(`  可选：${prep.manifest.optionalPermissions.join(", ")}`);
}
const names = prep.files.map((f) => f.path);
console.log(`  文件：${names.join(", ")}`);

// ---- 3. 市场规范核对 ----
console.log("\n[3/3] 市场规范核对…");
const problems = [];

if (prep.manifest.id !== manifest.id) {
  problems.push(`包内 id（${prep.manifest.id}）与 plugin.json 的 id（${manifest.id}）不一致`);
}
const dv = prep.manifest.contributes?.detailView;
for (const f of [dv?.entry, dv?.script]) {
  if (f && !names.includes(f)) problems.push(`包内缺清单声明的文件：${f}`);
}
if (!prep.manifest.contributes?.searchItem) {
  problems.push("没有 contributes.searchItem：用户无法用关键词唤起插件");
}
if (!(prep.manifest.permissions ?? []).includes("ui.inlay")) {
  problems.push("没有 ui.inlay 权限：插件界面打不开");
}
if (!(prep.manifest.permissions ?? []).includes("store")) {
  problems.push("没有 store 权限：固定项无法保存");
}

// 开发/测试产物绝不能进包（CI 里很容易漏，导致包体虚胖甚至泄漏内部文件）
const LEAK = [".github/", "test/", "tools/", "dist/", "node_modules/", ".git/"];
for (const p of names) {
  if (LEAK.some((prefix) => p.startsWith(prefix))) problems.push(`开发产物混进了包：${p}`);
}
if (names.some((p) => p === "README.md")) {
  problems.push("README.md 不应进包（是仓库文档，不是插件运行时内容）");
}

if (problems.length) {
  console.error("\n✗ 不符合规范：");
  for (const p of problems) console.error("  · " + p);
  process.exit(1);
}

console.log(`\n✅ 全部通过：${path.relative(root, outFile)}`);
console.log(`\n发版提示：`);
console.log(`  tag   = ${prep.manifest.id}   （稳定不变，不要为每个版本新建 tag）`);
console.log(`  asset = ${prep.manifest.id}.mspp`);
console.log(`  改 version 后重新打包，覆盖上传同一个 tag 即可。`);
