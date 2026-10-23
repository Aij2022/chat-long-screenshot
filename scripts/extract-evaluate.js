// ============================================================================
// extract-evaluate.js — ZCode 远程对话导出：第 1 步"现场提取"完整脚本
//
// 用法：先把本文件拷贝到工作目录（不要直接改已安装 skill 本体），再把整个文件
// 作为一个 cell 在 mcp__node_repl__js 里执行。执行前按需修改下方常量：
//   ORIGIN             —— 目标站点域名
//   REMOTE_URL_MATCH   —— 远程页 URL 的特征片段（用于自动绑定标签页）
//   OUT_FILE           —— 独立 HTML 落盘路径
//   FORCE_THEME        —— "dark" | "light"（导出主题）
//   ALT_FILE           —— 姊妹主题文件名（深/浅切换按钮；留空不注入）
//   DUAL / ALT_PAIR    —— 双主题一次提取开关与各主题姊妹链接（export-driver 注入用，手动别动）
//   SHADOW_HOSTS       —— 代码块 web 组件的标签名（逗号分隔可多个）
//
// 设计要点（详见 SKILL.md 踩坑清单）：
//   * 活页面零改动：定位 scroller → 记录祖先索引路径 → 在克隆体内打标/解锁。
//   * 等待消息流稳定：刚点开的会话经 WebSocket 分批同步，必须等 scrollHeight
//     连续两次采样一致再提取，否则只能导出半场对话。
//   * 【样式判定必须在活 DOM 上做】克隆体是游离节点，getComputedStyle 对它
//     返回空串（position/webkitAppRegion 全拿不到）——链上转 static、fixed
//     元素隐藏的判定一律在活 DOM 上完成，再按索引路径应用到克隆体。
//   * 克隆内重定位 scroller 与路径类改动，必须在删除 script/节点【之前】按
//     原始索引进行（路径按含 script 的树计算）。
//   * 轮次按 [data-v4-turn-unit] 数据属性定位（不同会话的包裹层级有差异）。
//   * 所有 <img> 的服务器相对路径必须改绝对地址 —— 破图会让 Chromium 打印时
//     跳过包含它的整张卡片（产物卡片全部消失的根因）。
//   * shadow CSS 作用域化时：:host(...) 用平衡括号解析（支持嵌套括号如
//     :host(:hover)），:host-context 依赖祖先上下文、拍平后丢弃；
//     @media (prefers-color-scheme: dark) 展开为无条件、light 变体丢弃；
//     light-dark(a,b) 在 CSSOM 序列化时即替换为暗/亮值（打印管线强制取 light）。
//   * 组合媒体查询（如 min-width 与 prefers-color-scheme 以 and 相连）只摘除
//     主题子句、保留其余条件，不做无条件展开。
//   * 落盘补 <!doctype html>（outerHTML 不含 doctype，缺了进 quirks 模式）。
//   * url 重写复用捕获引号：'url($1https://…'，绝不能再手写一个引号。
// ============================================================================

// 目标站点域名（按实际部署修改；包内不内置任何真实网址）
const ORIGIN = "https://example.com";
const REMOTE_URL_MATCH = ORIGIN + "/remote/v4?sid=";
const OUT_FILE = "D:/zcode/chat-export/conversation-export.html";
// 主题：导出深色或浅色变体（两种各导一次，文件互链即得切换功能）
const FORCE_THEME = "dark"; // "dark" | "light"
// 姊妹主题文件（相对 OUT_FILE 目录）；留空则不注入切换按钮
const ALT_FILE = "";
// 双主题一次提取（export-driver 用）：一次现场流水线同时产出 dark+light 两份 HTML，
// 活 DOM 采集/稳定等待/会话点击只做一遍。手动单步照旧：整个文件作为 cell 执行时 DUAL="0"
const DUAL = "0"; // "0" | "1"
// 各主题的姊妹文件链接（注入页面用；手动路径只有 FORCE_THEME 对应主题有 ALT）
const ALT_PAIR = { dark: FORCE_THEME === "dark" ? ALT_FILE : "", light: FORCE_THEME === "light" ? ALT_FILE : "" };
// 含 shadow DOM 的自定义元素标签（逗号分隔可列多个；拍平循环遍历全部实例）
const SHADOW_HOSTS = "diffs-container";

// ---------- node_repl 浏览器 bootstrap ----------
const browserPluginRoot =
  process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
if (!browserPluginRoot) throw new Error("Browser plugin root unavailable");
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const browserClientUrl = pathToFileURL(
  join(browserPluginRoot, "scripts", "browser-client.mjs"),
).href;
const { setupBrowserRuntime } = await import(browserClientUrl);
await setupBrowserRuntime({ globals: globalThis });

const browser = await agent.browsers.get("iab");
const tabs = await browser.tabs.list();
const info = tabs.find((t) => (t.url || "").includes(REMOTE_URL_MATCH));
if (!info) throw new Error("未找到远程页标签页，先在浏览器里打开并连接远程会话");
const tab = await browser.tabs.get(info.id);

// ---------- 前置探测片段（driver 逐发调用；每发亚秒级，不占桥 32s 预算）----------
// driver 在 loadExtractor 里按首尾标记切片本常量（声明行的行首到行尾收尾），把模式占位
// 串替换为 prep/stab/pen/backtop 后 evaluate。内容里不得出现反引号与插值序列。
// 注意：本注释及下 mode 语义说明都不得出现"声明行字面量"，否则切片 indexOf 会先命中
// 注释、切出残片（2026-10-20 实测翻车点，症状为提取前置全废）。
// mode 语义与原 A0/A0.5 一致：
//   prep    定位消息滚动容器并报告（found=false = 页面没开对话）
//   stab    单次高度采样（driver 连续两次一致判稳定，等价原 A0 的 14×1.5s 轮询）
//   pen     懒加载穿透单步：向下滚 0.6×clientHeight，触底/滚不动即 done
//           （IntersectionObserver 只有真实滚动能触发，等价原 A0.5 的整段循环）
//   backtop 回到顶部（穿透后真实图解码会改变高度，回顶后再 stab 一轮）
const PREP_SNIPPET = `(() => {
  const mode = "__MODE__";
  function locateScroller() {
    let best = null, bestDepth = -1;
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
          el.clientHeight > 300 && el.scrollHeight > el.clientHeight * 1.5 &&
          el.querySelector("p")) {
        const depth = (() => { let d = 0, p = el; while (p) { d++; p = p.parentElement; } return d; })();
        if (depth > bestDepth) { bestDepth = depth; best = el; }
      }
    }
    return best;
  }
  const s = locateScroller();
  if (mode === "pen") {
    if (!s) return { gone: true, done: true };
    const step = Math.max(400, Math.floor(s.clientHeight * 0.6));
    const before = s.scrollTop;
    s.scrollTop = before + step;
    const y = s.scrollTop;
    return { y: y, scrollH: s.scrollHeight,
             done: (y <= before + 1) || (y >= s.scrollHeight - s.clientHeight - 1) };
  }
  if (mode === "backtop") { if (s) s.scrollTop = 0; return { ok: !!s }; }
  if (!s) return mode === "stab" ? { scrollH: 0 } : { found: false };
  if (mode === "stab") return { scrollH: s.scrollHeight };
  return { found: true, clientH: s.clientHeight, scrollH: s.scrollHeight,
           turns: document.querySelectorAll("[data-v4-turn-unit]").length };
})()`;

// ---------- 手动模式前置：等稳定 + 懒加载穿透（app 3.16.2 起移出主 evaluate）----------
let stable = false;
{
  const prepCall = (mode) => tab.playwright.evaluate(PREP_SNIPPET.replace('"__MODE__"', JSON.stringify(mode)));
  const prep = await prepCall("prep");
  if (!prep || !prep.found) throw new Error("未找到消息滚动容器——先在页面上打开目标对话");
  let prevH = -1;
  for (let i = 0; i < 14; i++) {
    const s = await prepCall("stab");
    if (s && s.scrollH === prevH && s.scrollH > 300) { stable = true; break; }
    if (s) prevH = s.scrollH;
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (let guard = 0; guard < 400; guard++) {
    const r = await prepCall("pen");
    if (!r || r.gone || r.done) break;
    await new Promise((r2) => setTimeout(r2, 120));
  }
  await prepCall("backtop");
  prevH = -1;
  for (let i = 0; i < 6; i++) {
    const s = await prepCall("stab");
    if (s && s.scrollH === prevH && s.scrollH > 300) break;
    if (s) prevH = s.scrollH;
    await new Promise((r2) => setTimeout(r2, 1200));
  }
}

// ---------- 页面内提取（单次 evaluate，活页面零改动）----------
const exported = await tab.playwright.evaluate(`(async () => {
  const THEME = ${JSON.stringify(FORCE_THEME)};   // 由外层注入："dark" | "light"（单主题模式）
  const HOSTS = ${JSON.stringify(SHADOW_HOSTS)};  // 要拍平的 shadow 宿主标签
  const DUALF = ${JSON.stringify(DUAL)} === "1";  // 仅显式 "1" 走双主题一次流水线（修复真值坑："0" 是非空字符串恒真）
  const ALTPAIR = ${JSON.stringify(ALT_PAIR)};    // 各主题的姊妹文件链接（切深/浅按钮）
  const ORIGIN = ${JSON.stringify(ORIGIN)};       // 目标站点域名（页面代码内不得再依赖外层变量）
  function locateScroller() {
    let best = null, bestDepth = -1;
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
          el.clientHeight > 300 && el.scrollHeight > el.clientHeight * 1.5 &&
          el.querySelector("p")) {
        const depth = (() => { let d = 0, p = el; while (p) { d++; p = p.parentElement; } return d; })();
        if (depth > bestDepth) { bestDepth = depth; best = el; }
      }
    }
    return best;
  }

  // ===== A0/A0.5 已上移 export-driver（app 3.16.2 实测：稳定轮询最多 14×1.5s +
  //     滚动穿透 + 回顶再稳定内嵌在本 evaluate 里可达 ~40s，叠加 CSSOM 克隆必破
  //     node_repl 桥单命令 32s 上限（症状见坑清单）。现在 driver 用下方 PREP_SNIPPET
  //     在 Node 侧轮询完成"等稳定 → 逐步滚到底 → 回顶再等稳定"，本 evaluate 只做
  //     纯计算；手动单独跑本文件时，先在页面上把对话滚到底再执行）=====
  const scroller = locateScroller();
  if (!scroller) return { err: "no scroller" };

  // 记录从 <html> 下来的孩子索引路径（在未删改的活 DOM 上计算）
  const pathOf = (el) => {
    const p = [];
    for (let q = el; q !== document.documentElement; q = q.parentElement)
      p.unshift([...q.parentElement.children].indexOf(q));
    return p;
  };
  const scrollerPath = pathOf(scroller);

  // 诊断：活 DOM 里的 U+FFFD 数量（区分上游同步损坏 vs 导出损坏）
  const fffdLive = (document.body.innerText.match(/\\uFFFD/g) || []).length;

  // ===== A1. 活 DOM 上收集样式判定（克隆体是游离节点，getComputedStyle 拿不到值）=====
  const liveChain = [];
  for (let l = scroller; l && l !== document.documentElement; l = l.parentElement) liveChain.push(l);
  const liveChainSet = new Set(liveChain);
  const hidePaths = [];  // fixed 悬浮件 / app-drag 拖拽区（链上祖先除外——那些转 static 而非隐藏）
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.webkitAppRegion !== "drag") continue;
    if (liveChainSet.has(el)) continue;
    hidePaths.push(pathOf(el));
  }

  // ===== A2. 轮次清单（活 DOM；"部分轮次导出"的选择依据。克隆体是游离节点，
  //     innerText 拿不到渲染文本，必须在活 DOM 上取。一轮 = 一组问答：
  //     含 [data-v4-user-input-bubble] 的是用户发起轮，否则是纯回复/系统轮）=====
  const turnMeta = [...document.querySelectorAll("[data-v4-turn-unit]")].map((t, i) => ({
    i,
    user: !!t.querySelector("[data-v4-user-input-bubble]"),
    text: (t.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40),
  }));

  // ===== 主题无关的采集只做一次：跨域样式表计数、CSSOM 全量规则、图片 dataURL 缓存
  //     （双主题各建一份 clone，同一批图片只 fetch/转码一次）=====
  let crossOrigin = 0;
  const allRules = [];
  for (const sh of [...(document.adoptedStyleSheets || []), ...document.styleSheets]) {
    try { allRules.push(...sh.cssRules); } catch (e) { crossOrigin++; }
  }
  const dataUrlCache = new Map();  // src -> dataURL
  const blobToDataURL = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result); fr.onerror = rej;
    fr.readAsDataURL(blob);
  });

  // ===== B..I：每个主题构建一份独立 HTML（THEME=本份主题；ALT=本份的姊妹链接）=====
  async function buildFor(THEME, ALT) {

  // ===== B. 克隆整棵文档（孩子索引与活 DOM 完全一致）=====
  const clone = document.documentElement.cloneNode(true);
  if (THEME === "light") {
    // 浅色变体：换主题类 + color-scheme + data-* 主题属性
    // （站点 CSS 有 html[data-zcode-bootstrap-theme="light"] 等选择器，data 残留 dark 会让它们不命中）
    clone.classList.remove("dark", "theme-zai-dark");
    clone.classList.add("theme-zai-light");
    clone.setAttribute("style", (clone.getAttribute("style") || "").replace(/color-scheme\\s*:\\s*dark/gi, "color-scheme: light"));
    for (const attr of [...clone.attributes]) {
      if (attr.name.startsWith("data-") && attr.value.trim().toLowerCase() === "dark")
        clone.setAttribute(attr.name, "light");
    }
  }

  // ===== C. 克隆内按路径重定位 scroller；链打标 + 转 static + 隐藏链外兄弟；
  //     应用 A1 的隐藏清单。全部路径类改动必须在删 script 之前（路径按含
  //     script 的树计算）=====
  let node = clone;
  for (const i of scrollerPath) node = node.children[i];
  for (let p = node, l = scroller; p && p !== clone && l; p = p.parentElement, l = l.parentElement) {
    p.dataset.exportKeep = "1";
    // 链上 absolute/fixed 容器转 static（判定在活 DOM 对应元素上做）
    const s = getComputedStyle(l);
    if (s.position === "absolute" || s.position === "fixed") p.style.position = "static";
    if (p.parentElement)
      for (const sib of [...p.parentElement.children])
        if (sib !== p) sib.style.display = "none";
  }
  for (const path of hidePaths) {
    let t = clone;
    for (const i of path) { t = t.children && t.children[i]; if (!t) break; }
    if (t && t.style) t.style.display = "none";
  }
  clone.querySelectorAll("script, noscript, link[rel='stylesheet']").forEach((s) => s.remove());

  // ===== D. 主 CSS：CSSOM 走树（含 adoptedStyleSheets）；dark 媒体展开为无条件、
  //     light 丢弃（无头渲染默认 light 偏好）；light-dark() 替换为主题值；
  //     url 重写【复用捕获引号，勿动】=====
  function forceLD(txt) {
    // light-dark(a,b) → THEME==="dark" ? b : a（打印管线会按 color-scheme 取 light 值）
    const needle = "light-dark(";
    let out = txt, i = out.indexOf(needle);
    while (i !== -1) {
      let depth = 0, bracket = 0, quote = null, comma = -1, j = i + needle.length - 1;
      for (; j < out.length; j++) {
        const c = out[j];
        if (quote) { if (c === quote) quote = null; continue; }   // 引号内逗号不是参数分隔符
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) break; }
        else if (c === "[") bracket++;
        else if (c === "]") bracket--;
        else if (c === "," && depth === 1 && bracket === 0 && comma === -1) comma = j;
      }
      // 畸形出现（无配对逗号/括号）：跳过本次，继续向后扫
      if (comma === -1 || j >= out.length || depth !== 0) { i = out.indexOf(needle, i + needle.length); continue; }
      const rep = THEME === "dark" ? out.slice(comma + 1, j) : out.slice(i + needle.length, comma);
      out = out.slice(0, i) + rep + out.slice(j + 1);
      i = out.indexOf(needle, i);
    }
    return out;
  }
  function rewriteMedia(cond, wantDark) {
    // 返回 "" = 无条件展开；null = 整块丢弃；其他 = 保留该（剩余）条件。
    // 仅处理 and 组合的主题子句；or 等复杂条件原样保留（保守）。
    cond = cond.trim();
    // "not all and (子句)"：整体真假 = 内部取反，递归求内层后反转极性；
    // 内层若还是剩余条件串则无法安全反转，原样保留。
    const notM = cond.match(/^not\\s+all\\s+and\\s+([\\s\\S]+)$/i);
    if (notM) {
      const inner = rewriteMedia(notM[1], wantDark);
      if (inner === "") return null;   // 内层恒真 → not → 恒假 → 丢弃
      if (inner === null) return "";   // 内层恒假 → not → 恒真 → 展开
      return cond;
    }
    // 逗号媒体查询列表（"A, B" 任一段命中即命中）：顶层逗号分段（引号/括号内的
    // 逗号不切），逐段递归——命中当前主题的段恒真 → 整条无条件展开；不命中的段
    // 丢弃；只对无变化的段原样保留原始串（含空白）。
    if (cond.includes(",")) {
      const segs = splitTopLevel(cond);
      if (segs.length > 1) {
        const keptSegs = [];
        let always = false;
        for (const seg of segs) {
          const r = rewriteMedia(seg, wantDark);
          if (r === null) continue;
          if (r === "") { always = true; break; }
          keptSegs.push(r);
        }
        if (always) return "";
        if (!keptSegs.length) return null;
        return keptSegs.join(", ");
      }
    }
    const parts = cond.split(/\\s+and\\s+/i);
    let sawCS = false;
    const kept = [];
    for (const part of parts) {
      const t = part.trim();
      if (/^\\(?\\s*prefers-color-scheme:\\s*dark\\s*\\)?$/i.test(t)) { sawCS = true; if (!wantDark) return null; continue; }
      if (/^\\(?\\s*prefers-color-scheme:\\s*light\\s*\\)?$/i.test(t)) { sawCS = true; if (wantDark) return null; continue; }
      kept.push(t);
    }
    if (!sawCS) return cond;
    return kept.filter(Boolean).join(" and ");
  }
  function cssText(ruleList) {
    const out = [];
    for (const rule of ruleList) {
      const cname = rule.constructor ? rule.constructor.name : "";
      if (cname === "CSSMediaRule") {
        const r = rewriteMedia(rule.conditionText || "", THEME === "dark");
        if (r === null) continue;
        if (r === "") { out.push(cssText(rule.cssRules)); continue; }
        out.push("@media " + r + " {" + cssText(rule.cssRules) + "}");
      } else if (cname === "CSSLayerBlockRule" || cname === "CSSSupportsRule") {
        const head = rule.cssText.split("{")[0].trim();
        out.push(head + " {" + cssText(rule.cssRules) + "}");
      } else {
        out.push(forceLD(rule.cssText));
      }
    }
    return out.join("\\n");
  }
  const mainCSS = cssText(allRules)
    .replace(/url\\((["']?)\\/(?!\\/)/g, "url($1" + ORIGIN + "/")
    .replace(/url\\((["']?)\\/\\/(?!\\))/g, "url($1https://");

  // ===== E. shadow DOM 递归拍平 + CSSOM 作用域化 =====
  const shadowCSSTexts = [];
  function splitTopLevel(s) {
    // 顶层逗号切分：引号/圆括号/方括号内的逗号不切（:not(.a,.b)/[attr="a,b"]/:host(.a,.b) 安全）
    const parts = [];
    let depthP = 0, depthB = 0, quote = null, cur = "";
    for (const c of s) {
      if (quote) { cur += c; if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"') { quote = c; cur += c; continue; }
      if (c === "(") depthP++;
      else if (c === ")") depthP--;
      else if (c === "[") depthB++;
      else if (c === "]") depthB--;
      else if (c === "," && depthP === 0 && depthB === 0) { parts.push(cur); cur = ""; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts.map((t) => t.trim()).filter(Boolean);
  }
  function scopeHost(sel, prefix) {
    // :host(...) 平衡括号解析（支持 :host(:hover)/:host(:not(.x))）；
    // :host-context(...) 依赖祖先上下文，拍平后无意义 → 用不匹配任何元素的
    // 合法选择器占位（不能用非法串，否则整条逗号组规则都会被丢弃）
    const rest = sel.slice(5);
    if (rest.startsWith("(")) {
      let depth = 0;
      for (let k = 0; k < rest.length; k++) {
        if (rest[k] === "(") depth++;
        else if (rest[k] === ")") {
          depth--;
          if (depth === 0) {
            // :host() 参数可以是选择器列表（:host(.a, .b)），逐段加前缀；inner 自带
            // :hover/[attr]/:not() 等完整条件，直接拼在宿主名后（不要再包圆括号——非法）
            const tail = rest.slice(k + 1).trim();
            return splitTopLevel(rest.slice(1, k)).map((p2) => prefix + p2 + (tail ? " " + tail : "")).join(", ");
          }
        }
      }
      return "#host-selector-dropped";
    }
    if (rest.startsWith("-context")) return "#host-selector-dropped";
    return prefix + rest;
  }
  function scopeRules(ruleList, prefix) {
    let out = "";
    for (const rule of ruleList) {
      const cname = rule.constructor ? rule.constructor.name : "";
      if (cname === "CSSStyleRule") {
        const sel = splitTopLevel(rule.selectorText).map((s) => {
          if (s.startsWith(":host")) return scopeHost(s, prefix);
          if (s.startsWith("&")) return s.replace("&", prefix);
          return prefix + " " + s;
        }).join(", ");
        out += sel + " {" + forceLD(rule.style.cssText) + "}\\n";
      } else if (cname === "CSSMediaRule") {
        const r = rewriteMedia(rule.conditionText || "", THEME === "dark");
        if (r === null) continue;
        if (r === "") { out += scopeRules(rule.cssRules, prefix); continue; }
        out += "@media " + r + " {" + scopeRules(rule.cssRules, prefix) + "}\\n";
      } else if (cname === "CSSKeyframesRule" || cname === "CSSFontFaceRule") {
        out += forceLD(rule.cssText) + "\\n";
      } else if (cname === "CSSLayerStatementRule") {
        // 裸 @layer a,b; 语句在全局会重排层叠顺序，丢弃
      } else if (rule.cssRules && rule.cssRules.length > 0) {
        const head = rule.cssText.split("{")[0].trim();
        out += head + " {" + scopeRules(rule.cssRules, prefix) + "}\\n";
      }
    }
    return out;
  }
  function parseCSS(text) {
    const d = document.implementation.createHTMLDocument("");
    const st = d.createElement("style");
    st.textContent = text;
    d.head.appendChild(st);
    return st.sheet ? st.sheet.cssRules : null;
  }
  function flattenClone(nodeIn) {
    // 递归拍平：每个 shadow 宿主用自身标签名作作用域前缀（嵌套 shadow 各归各）。
    // 已知局限：不处理 <slot>/::slotted（shadow 含 slot 时浅树子节点会整体落到
    // slot 之后、结构错位）——当前 diffs-container 不用 slot；换站点时先按
    // SKILL.md 要求跑一轮完整验收，若目标组件用了 slot 需先扩展本函数。
    if (nodeIn.nodeType === Node.TEXT_NODE) return nodeIn.cloneNode();
    const el = nodeIn.cloneNode(false);
    if (nodeIn.shadowRoot) {
      const myPrefix = nodeIn.tagName.toLowerCase();
      for (const sh of (nodeIn.shadowRoot.adoptedStyleSheets || [])) {
        try { shadowCSSTexts.push(scopeRules(sh.cssRules, myPrefix)); } catch (e) {}
      }
      for (const child of nodeIn.shadowRoot.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "STYLE") {
          const rules = parseCSS(child.textContent);
          if (rules) shadowCSSTexts.push(scopeRules(rules, myPrefix));
        } else {
          el.appendChild(flattenClone(child));
        }
      }
    }
    for (const child of nodeIn.childNodes) el.appendChild(flattenClone(child));
    return el;
  }
  const liveHosts = [...document.querySelectorAll(HOSTS)];
  const cloneHosts = [...clone.querySelectorAll(HOSTS)];
  let flattened = 0;
  for (let k = 0; k < Math.min(liveHosts.length, cloneHosts.length); k++) {
    if (!liveHosts[k].shadowRoot) continue;  // 无 shadow 的实例保留原样
    const flat = flattenClone(liveHosts[k]);
    flat.removeAttribute("style");
    // 强制显示行号（线上页面显示行号；去掉禁用标记防止作用域规则隐藏）
    flat.querySelectorAll("[data-disable-line-numbers]").forEach((el) => el.removeAttribute("data-disable-line-numbers"));
    cloneHosts[k].replaceWith(flat);
    flattened++;
  }
  // 同名组件的多实例会产出重复的作用域 CSS，去重
  const shadowCSS = [...new Set(shadowCSSTexts)];
  // 拍平源自活宿主，可能把 shadow/浅树里的 <script>/<link> 重新带进来，补一次清除
  clone.querySelectorAll("script, noscript, link[rel='stylesheet']").forEach((s) => s.remove());

  // ===== F. 轮次转文档流（按 data 属性定位——不同会话的包裹层级会有差异，
  //     固定的 firstElementChild 链条会在某些状态下指错节点，症状是 PDF 只有 1 页）=====
  const turns = clone.querySelectorAll("[data-v4-turn-unit]");
  for (const t of turns) { t.style.position = "static"; t.style.transform = "none"; }
  if (turns.length)
    for (let p = turns[0].parentElement; p && p !== node; p = p.parentElement) p.style.height = "auto";

  // 轮次根标记：每个轮次的"只含该轮次的最高祖先"两侧插注释（ZTURN:i:s / ZTURN:i:e），
  // 供文件级"部分轮次导出"安全裁剪。轮次的父层级不统一（常规轮次互为兄弟挂在列表
  // 容器下、进行中的末轮挂在外层容器上），标记贴轮次元素本身会跨容器边界——包住
  // 轮次根后标记总落在完整元素的边界，删除任一 [s…e] 跨度（整棵子树）后仍平衡
  let turnsMarked = 0;
  if (turns.length === turnMeta.length) {
    [...turns].forEach((t, i) => {
      let r = t;
      while (r.parentElement && r.parentElement !== node && node.contains(r.parentElement) &&
             r.parentElement.querySelectorAll("[data-v4-turn-unit]").length <= 1) r = r.parentElement;
      if (!r.parentElement) return;
      r.parentElement.insertBefore(document.createComment("ZTURN:" + i + ":s"), r);
      r.parentElement.insertBefore(document.createComment("ZTURN:" + i + ":e"), r.nextSibling);
      turnsMarked++;
    });
  }
  // 编辑铅笔等悬停件：精确 testid 锚点 + 用户消息动作行第一个按钮之后的兜底隐藏
  clone.querySelectorAll("[data-testid^='v4-edit']").forEach((el) => el.style.display = "none");
  for (const bubble of clone.querySelectorAll("[data-v4-user-input-bubble]")) {
    const row = bubble.closest("[class*='group/history-message']");
    if (!row) continue;
    const btns = row.querySelectorAll("button");
    for (let i = 1; i < btns.length; i++) {
      if (String(btns[i].className).includes("group/button")) btns[i].style.display = "none";
    }
  }

  // 输入坞：精确属性锚点（data-v4-composer-dock），兜底用 contenteditable 向上找分支点
  const dock = clone.querySelector("[data-v4-composer-dock]");
  if (dock) {
    dock.style.display = "none";
  } else {
    const ta = [...clone.querySelectorAll("[contenteditable='true'], textarea")]
      .find((el) => !node.contains(el));
    if (ta) {
      let p = ta;
      while (p.parentElement && !p.parentElement.contains(node)) p = p.parentElement;
      if (p !== node && !node.contains(p)) p.style.display = "none";
    }
  }
  for (const el of clone.querySelectorAll("input[type=file]")) el.style.display = "none";

  // ===== H. 图片路径：blob 转 dataURL；服务器相对路径转绝对地址
  //     （破图会让 Chromium 打印时跳过包含它的整张卡片！）=====
  const imgs = [...clone.querySelectorAll("img")];
  for (const img of imgs) {
    if (img.src.startsWith("blob:")) {
      try {
        if (!dataUrlCache.has(img.src)) {
          const resp = await fetch(img.src);
          dataUrlCache.set(img.src, await blobToDataURL(await resp.blob()));
        }
        img.src = dataUrlCache.get(img.src);
      } catch (e) { img.removeAttribute("src"); }
    } else {
      const attr = img.getAttribute("src");
      if (attr && !/^(https?:|data:|blob:)/i.test(attr)) {
        // 相对/根相对/协议相对一律按页面基址绝对化（new URL 正确处理三类形态）
        img.src = new URL(attr, location.href).href;
      }
      // 同源图片就地下成 dataURL：导出文件完全离线自包含；内嵌工具的 PNG 生成走
      // SVG foreignObject（不加载任何外部资源），不转 dataURL 的图会从 PNG 里消失
      if (/^https?:/i.test(img.src)) {
        try {
          if (new URL(img.src).origin === ORIGIN) {
            if (!dataUrlCache.has(img.src)) {
              const resp2 = await fetch(img.src);
              const blob2 = await resp2.blob();
              if (blob2.size <= 786432) dataUrlCache.set(img.src, await blobToDataURL(blob2));
            }
            if (dataUrlCache.has(img.src)) img.src = dataUrlCache.get(img.src);
          }
        } catch (e2) { /* 转不动就保留绝对地址（显示/打印仍可用） */ }
      }
    }
    if (img.getAttribute("srcset")) {
      // "url 描述符, url 描述符"：逗号分隔，但 dataURL 的 base64 段自带逗号——
      // 只在"逗号后紧跟 URL 起点（data:/http(s):/协议相对/根相对）"处切分；
      // blob: 段无法同步转 dataURL，丢弃（回退 src）
      img.srcset = img.srcset.split(/,(?=\\s*(?:data:|https?:|\\/\\/|\\/))/i).map((part) => {
        const t = part.trim();
        const u = t.split(/\\s+/)[0];
        if (!u || /^(https?:|data:)/i.test(u)) return t;
        if (/^blob:/i.test(u)) return "";
        return new URL(u, location.href).href + t.slice(u.length);
      }).filter(Boolean).join(", ");
    }
    // src 已是 dataURL 时 srcset（远程）会反优先级压过它，丢掉保离线自包含
    if (img.src.startsWith("data:") && img.getAttribute("srcset")) img.removeAttribute("srcset");
    // 懒加载图没有 width/height：滚动到位解码瞬间最多撑高数百像素，下方内容整体下移——
    // 打印/截图的高度测量与内嵌工具的定位全被坑。去懒加载 + 等解码（限时）+ 补属性占位
    img.removeAttribute("loading");
    img.removeAttribute("fetchpriority");
    img.removeAttribute("decoding");
    if (!img.getAttribute("width") || !img.getAttribute("height")) {
      try {
        await Promise.race([img.decode(), new Promise((r2) => setTimeout(r2, 1200))]);
      } catch (e3) { /* 解码失败保留原状 */ }
      if (img.naturalWidth && !img.getAttribute("width")) img.setAttribute("width", String(img.naturalWidth));
      if (img.naturalHeight && !img.getAttribute("height")) img.setAttribute("height", String(img.naturalHeight));
    }
  }

  // ===== I. 组装 head =====
  const head = clone.querySelector("head");
  const meta = document.createElement("meta");
  meta.setAttribute("charset", "utf-8");
  head.insertBefore(meta, head.firstChild);
  const s1 = document.createElement("style"); s1.textContent = mainCSS;
  head.insertBefore(s1, meta.nextSibling);
  const shadowCSSJoined = shadowCSS.join("\\n");
  const s2 = document.createElement("style");
  s2.textContent = shadowCSSJoined + \`
    html, body, [data-export-keep] { height: auto !important; min-height: 0 !important; overflow: visible !important; }
\` + "    html, body { scrollbar-width: none; background: " + (THEME === "dark" ? "#161616" : "#f8f8f8") + " !important; }" + \`
    body { padding: 14px !important; }
    *, *::before, *::after { content-visibility: visible !important; animation: none !important; transition: none !important; }
    section:empty { display: none !important; }
    ${SHADOW_HOSTS} { display: block; break-inside: avoid; page-break-inside: avoid; }
    ${SHADOW_HOSTS} pre { break-inside: avoid; page-break-inside: avoid; }
    [data-v4-turn-unit] { break-inside: auto; }    [data-export-keep] :last-child { margin-bottom: 0 !important; }
    h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
    p { orphans: 3; widows: 3; }
    .border-t { border-top-width: 0 !important; }  /* 顶部细线：面板容器 border-t 类，须全局清除（分隔线是 border-b 不受影响） */
    @media print { #themeToggleBtn { display: none !important; } }
    @page { size: A4 portrait; margin: 10mm 0; }
  \`;
  head.appendChild(s2);
  // 大字符串经桥接传输会被确定性损坏（非 ASCII 内容 → U+FFFD）：
  // percent-encode 成纯 ASCII 暂存在页面 window 上，Node 侧分块取回并逐块校验
  // 深浅色切换按钮（浮动角标，链接姊妹主题文件；@media print 中自动隐藏）
  if (ALT) {
    const btn = document.createElement("button");
    btn.id = "themeToggleBtn";
    btn.textContent = THEME === "dark" ? "☀ 浅色" : "🌙 深色";
    btn.setAttribute("onclick", "location.href='" + ALT + "'");
    btn.style.cssText = "position:fixed;top:10px;right:10px;z-index:99999;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;" +
      (THEME === "dark" ? "background:#2a2a2a;color:#eee;border:1px solid #555;" : "background:#fff;color:#333;border:1px solid #ccc;");
    clone.appendChild(btn);
  }
  const htmlEnc = encodeURIComponent(clone.outerHTML);
  let h = 0;
  for (let i = 0; i < htmlEnc.length; i++) h = (h * 31 + htmlEnc.charCodeAt(i)) | 0;
  return { htmlEnc, sum: h >>> 0, blobs: imgs.length, shadowCSS: shadowCSS.length,
           hostsFlattened: flattened, turns: turns.length, turnsMarked };
  }

  // ===== 产出：双主题各一份（一次流水线），或单主题（手动分步照旧）=====
  let result;
  if (DUALF) {
    const d = await buildFor("dark", ALTPAIR.dark || "");
    const l = await buildFor("light", ALTPAIR.light || "");
    window.__zexport = { dual: {
      dark: { html: d.htmlEnc, sum: d.sum },
      light: { html: l.htmlEnc, sum: l.sum },
    } };
    result = { ok: true, dual: { dark: { len: d.htmlEnc.length, sum: d.sum },
                                 light: { len: l.htmlEnc.length, sum: l.sum } },
               blobs: d.blobs + l.blobs, shadowCSS: d.shadowCSS, hostsFlattened: d.hostsFlattened,
               turns: d.turns, turnsMarked: d.turnsMarked, fffdLive, crossOrigin,
               turnMeta: encodeURIComponent(JSON.stringify(turnMeta)) };
  } else {
    const s = await buildFor(THEME, ALTPAIR[THEME] || "");
    window.__zexport = { html: s.htmlEnc, sum: s.sum };
    result = { ok: true, len: s.htmlEnc.length, sum: s.sum, blobs: s.blobs,
               shadowCSS: s.shadowCSS, hostsFlattened: s.hostsFlattened, turns: s.turns,
               turnsMarked: s.turnsMarked, fffdLive, crossOrigin,
               turnMeta: encodeURIComponent(JSON.stringify(turnMeta)) };
  }
  return result;
})()`);

if (exported.err) throw new Error("提取失败: " + exported.err);
if (!exported.ok) throw new Error("提取返回异常");

// ---------- Node 侧：分块取回（ASCII 安全）+ 逐块校验 + 坏块对半拆分重取 ----------
const fetchChunk = (off, len, key) => tab.playwright.evaluate(
  `((key) => {
    const src = key ? window.__zexport.dual[key].html : window.__zexport.html;
    const s = src.substr(${off}, ${len});
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return { t: s, s: h >>> 0 };
  })(${JSON.stringify(key || null)})`
);
const nodeSum = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
};
async function fetchRange(off, len, key) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchChunk(off, len, key);
    if (r.t.length === len && r.s === nodeSum(r.t)) return r.t;
  }
  // 桥接损坏是确定性的：原样重试必然复现，把块对半拆开重取
  if (len <= 65536) throw new Error(`分块校验失败 @${off}（拆至 64KB 仍持续损坏）`);
  const mid = len >> 1;
  return (await fetchRange(off, mid, key)) + (await fetchRange(off + mid, len - mid, key));
}

const CHUNK = 1048576; // 1M ASCII 字符
let htmlEnc = "";
for (let off = 0; off < exported.len; off += CHUNK)
  htmlEnc += await fetchRange(off, Math.min(CHUNK, exported.len - off));
if (htmlEnc.length !== exported.len || nodeSum(htmlEnc) !== exported.sum)
  throw new Error("整串校验失败");
let html = decodeURIComponent(htmlEnc);

// 兜底：内联 style 属性与页面自带 <style> 块里的 light-dark()（CSSOM 路径已处理规则级）。
// 只作用于这两处，避免篡改对话正文里展示的代码文本。
const forceLDNode = (txt, theme = FORCE_THEME) => {
  const needle = "light-dark(";
  let out = txt, i = out.indexOf(needle);
  while (i !== -1) {
    let depth = 0, bracket = 0, quote = null, comma = -1, j = i + needle.length - 1;
    for (; j < out.length; j++) {
      const c = out[j];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      else if (c === "[") bracket++;
      else if (c === "]") bracket--;
      else if (c === "," && depth === 1 && bracket === 0 && comma === -1) comma = j;
    }
    if (comma === -1 || j >= out.length || depth !== 0) { i = out.indexOf(needle, i + needle.length); continue; }
    const rep = theme === "dark" ? out.slice(comma + 1, j) : out.slice(i + needle.length, comma);
    out = out.slice(0, i) + rep + out.slice(j + 1);
    i = out.indexOf(needle, i);
  }
  return out;
};
// style 属性须锚定在真实标签上（<[a-z]…）——转义展示的教程代码（&lt;div style=…）不命中
html = html.replace(/(<[a-zA-Z][^>]*?\sstyle=")([^"]*)(")/g,
  (m, pre, val, post) => pre + forceLDNode(val).replace(/url\((["']?)\/(?!\/)/g, "url($1" + ORIGIN + "/") + post);
html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, (m) => forceLDNode(m));

const { writeFile, mkdir } = await import("node:fs/promises");
const { dirname } = await import("node:path");
await mkdir(dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, "<!doctype html>\n" + html);
// 暂存清理放在落盘成功之后：写盘失败时窗口暂存还在，可重试取回而不必重新提取
await tab.playwright.evaluate(`(() => { delete window.__zexport; return true; })()`);if (!stable)
  console.warn("警告: 消息流在等待期内未稳定，产物可能缺少最新轮次，建议稍后重试提取");
if (exported.crossOrigin > 0)
  console.warn("警告: " + exported.crossOrigin + " 个样式表跨域无法读取规则，导出可能缺样式");
({
  out: OUT_FILE,
  bytes: html.length,
  blobsConverted: exported.blobs,
  shadowCSSChunks: exported.shadowCSS,
  hostsFlattened: exported.hostsFlattened,
  turns: exported.turns,
  turnsMarked: exported.turnsMarked,
  fffdInLiveDOM: exported.fffdLive,
  stable,
});
