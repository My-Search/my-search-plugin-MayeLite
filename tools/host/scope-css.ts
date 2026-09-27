/**
 * 插件 CSS 作用域化（scopeCss）。
 *
 * 本文件是**宿主仓库 src/lib/util.ts 里 scopeCss 相关函数簇的副本**（宿主
 * 与插件 CSS 的约定：插件样式从不作为全局样式注入，而是一律加
 * `#text_show .plugin-view` 前缀）。单独 vendor 这一个函数簇，是为了让插件
 * 仓库能独立跑「scoped 之后样式是否仍生效」的测试，而不必拖入 util.ts 的
 * 全部依赖（showdown 等）。
 *
 * 升级方式：从宿主 src/lib/util.ts 同步覆盖本文件的函数体。
 */

export function scopeCss(css: string | null | undefined, prefix: string): string {
  const clean = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  return scopeCssBlocks(clean, prefix).join("\n");
}

/** 将选择器列表作用域化（根选择器映射为容器自身） */
function scopeSelectorList(sel: string, prefix: string): string {
  return sel
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^(\*|html|body|:root)$/i.test(s) ? prefix : `${prefix} ${s}`))
    .join(", ");
}

/**
 * 解析 CSS 为顶层块并逐个作用域化（保留原样换行，输出与原文字节接近）
 * @param {string} css
 * @param {string} prefix
 * @returns {string[]}
 */
function scopeCssBlocks(css: string, prefix: string): string[] {
  const out = [];
  let plain = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      // plain 中累积的就是当前块的选择器 / at-rule 头部
      const header = plain.trim();
      plain = "";
      const body = readBlock(css, i + 1);
      i = body.end + 1; // 跳到本块的闭合花括号之后
      const inner = body.text;
      if (!header) continue;
      if (header.startsWith("@")) {
        const at = header.toLowerCase();
        if (at.startsWith("@keyframes") || at.startsWith("@-webkit-keyframes")) {
          // 关键帧内部（from/to/百分比）不能加作用域，原样保留
          out.push(`${header} {${inner}}`);
        } else {
          // @media / @supports 等：递归处理内部规则
          const nested = scopeCssBlocks(inner, prefix);
          out.push(`${header} {\n${nested.join("\n")}\n}`);
        }
      } else {
        out.push(`${scopeSelectorList(header, prefix)} {${inner}}`);
      }
      continue;
    }
    // 顶层多余的 `}`（脏 CSS）直接跳过，不影响后续规则
    if (ch !== "}") plain += ch;
    i++;
  }
  if (plain.trim()) out.push(plain.trim());
  return out;
}

/** 从 pos 开始读取 `{...}` 之间的内容（配对花括号，忽略字符串与注释） */
function readBlock(css: string, pos: number): { text: string; end: number } {
  let depth = 1;
  let i = pos;
  let quote: string | null = null;
  let text = "";
  for (; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      text += ch;
      if (ch === "\\") {
        text += css[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      text += ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    text += ch;
  }
  return { text, end: i };
}
