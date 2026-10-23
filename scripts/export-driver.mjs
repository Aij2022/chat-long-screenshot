// ============================================================================
// export-driver.mjs — 对话长截图一条龙驱动（open → [用户选对话 + "开始"] → extract → render → verify）
//
// 用法：cell 顶层先按 control-browser skill 的方式 setupBrowserRuntime 并取 browser，
// 再 import 本模块调用 runPhase(phase, { browser, ... })。
// （模块在真实 Node 域执行，取不到 cell 沙箱全局——浏览器句柄必须传参）
//
// 相位：
//   open    连接/复用远程页（按 sid 防自踢，被踢自动点"重新连接"），探活后即停：
//           会话由用户在页面上自行点开，agent 转告用户并等待聊天里的"开始"指令。
//           全流程零 AskUserQuestion、零参数询问。
//   extract 导出会话（session:"当前" = 页面上已打开的对话，标准入口）→ 复用
//           extract-evaluate.js 按主题落盘 HTML，应用导出参数（字号/留白/横版注入 CSS）。
//           默认深浅两主题一次流水线同时产出（活页面采集/克隆只做一遍，图片共享
//           dataURL 缓存）；formats 不含 pdf 且 theme≠both 时只产长图主题一份。
//           part 参数保留但已无作用（旧双次调用兼容）。
//   plan    （兜底，不再推荐）老交互流程：解析会话列表做匹配/返回最近列表，由 agent
//           展示给用户挑选。新流程一律走 open + 用户页面自选。
//   filter  部分轮次导出（仅当用户明确要求"只导出第几轮/最后几轮"时才走）：
//           turns="2,5-7" | "last3" | "all"（支持圈号③/开区间3-/中文逗号）。
//           未带 spec 时返回轮次清单 + 询问素材（turnsAsk）。文件级删除未选轮次子树
//           （提取时已插 ZTURN 标记），全量备份在 .full-html/，可反复改选而无需
//           重新提取；产物目录写 turns.json。
//   render  按参数（theme/formats/grayscale/longWidth/cropSides）并行渲染并归档：
//           <会话名>.html / .light.html / -long.png / -light-long.png / .pdf /
//           -dark.pdf / -long.pdf / -light-long.pdf / -long.jpg / pages/。
//   verify  脚本化质检（页数/乱码/输入坞残留/长图非空/灰度与横版校验；
//           部分导出时文本量/长图高度阈值自动放宽）。
//
// 导出参数（extract 相位传入，写入状态供后续相位使用）：
//   theme: "default"(HTML深+PDF白) | "dark" | "light" | "both"(深浅两套全要)
//   fontSize: 12|14(默认)|16|18      pageMargin: 8|14(默认)|24
//   orientation: "portrait"(默认)|"landscape"   grayscale: false(默认)|true
//   formats: ["html","pdf","longpdf","longpng","longjpg"] 子集（默认 ["html","pdf"]）
//            longpdf = 整场一张按内容定高的超长页 PDF（深色随长图主题；>18900px 自动分段）
//   longWidth: 1024|1280(默认)|1600  cropSides: true(默认)|false（长图左右裁边）
//   turns: 轮次筛选 spec（filter 相位用；extract 已设筛选时新提取自动重滤）
//   maxList: 15(默认)——plan select 态返回的最近会话数上限
//   shadowHosts: "diffs-container"(默认)——shadow 宿主标签，逗号分隔可多个
//   composerText: "提出后续修改要求"(默认)——输入坞文案锚点，站点改版时覆盖
//
// 跨 cell 状态：系统临时目录 ._chat-export-state.json（路径固定，不随 outRoot 变）。
// ============================================================================

import { readFile, writeFile, mkdir, rm, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";

function defaultOutRoot() {
  // 默认落 D 盘（本机约定）；无 D 盘的机器退回用户目录，避免 plan 一上来就败
  try { if (existsSync("D:/")) return "D:/zcode/chat-export"; } catch { /* 忽略 */ }
  return path.join(process.env.USERPROFILE || process.env.HOME || ".", "chat-export");
}

export const DEFAULTS = {
  url: "",                 // 远程页完整 URL（plan 必填；只在本相位使用，不写入状态文件）
  session: "",             // 可选：目标会话名（模糊匹配；"当前"= 当前打开的对话）
  pick: "",                // extract：用户选定的会话名或序号（含圈号 ⑫）
  part: "long",            // extract："long" | "pdf"
  outRoot: defaultOutRoot(),
  theme: "default",        // default | dark | light | both
  fontSize: 14,            // 12 | 14 | 16 | 18
  pageMargin: 14,          // 8 | 14 | 24
  orientation: "portrait", // portrait | landscape
  grayscale: false,        // PDF 灰度（打印省墨，保留文本层）
  formats: ["html", "pdf"],
  longWidth: 1280,         // 1024 | 1280 | 1600
  cropSides: true,
  turns: "",               // filter 相位：轮次筛选 spec（"2,5-7" | "last3" | "all"）
  skillDir: "",            // 留空 = 驱动文件所在目录
  maxList: 15,             // plan select 态返回的最近会话数上限（SKILL.md 的"最近 15 个"）
  shadowHosts: "diffs-container",   // shadow 宿主标签，逗号分隔可多个（换站点时覆盖）
  composerText: "提出后续修改要求", // 输入坞文案锚点（verify 质检用；站点改版时可覆盖）
};

const THEME_MAP = {
  default: { long: "dark", pdf: "light" },
  dark: { long: "dark", pdf: "dark" },
  light: { long: "light", pdf: "light" },
  both: { long: "dark", pdf: "light" }, // 提取仍深浅各一，render 阶段两套产物都要
};

// 状态文件放系统临时目录（路径固定，不随 outRoot 变化，跨相位可寻）
const STATE_PATH = path.join(process.env.TEMP || process.env.TMP || ".", "._chat-export-state.json");
function statePath() {
  return STATE_PATH;
}

// 远程控制链接＝电脑控制权：约定私密存放于用户目录（首条非注释行），
// 调用方未显式传 url 时自动读取——链接不再需要出现在聊天/脚本/产物里
const REMOTE_URL_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || ".", ".zcode", "secrets", "zcode-remote-session.url");
async function urlFromStore() {
  try {
    const raw = await readFile(REMOTE_URL_FILE, "utf8");
    const line = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
    return line ? line.trim() : "";
  } catch { return ""; }
}

// 注入锚点：只认文档末尾的闭合标签（取最后一次出现）——产物里内嵌工具脚本的注释、
// 对话正文（转义前）、标签属性值都可能含 "</head>"/"</body>" 字面量（本工具链聊的
// 就是这些标记），按"第一个"定位必被抢先命中（踩坑清单"注入锚点被源码注释抢命中"）。
// 序列化后的 HTML 里，真正的 </body> 一定是最后一次出现（正文里的字面量已被转义，
// 属性值里的都位于真闭合标签之前）。
function injectAtEnd(html, payload) {
  const low = html.toLowerCase();
  let i = low.lastIndexOf("</body></html>");
  if (i === -1) i = low.lastIndexOf("</body>");
  if (i === -1) i = low.lastIndexOf("</html>");
  if (i === -1) return html + payload;
  return html.slice(0, i) + payload + html.slice(i);
}

// ---------- 小工具 ----------
// 剥 ' 和 &：会话名会进主题切换按钮的 onclick='location.href="<名>.light.html"'
// 手拼串——单引号弄断 JS，& 有实体误解析风险
function safeName(name) {
  let s = (name || "").replace(/[\\/:*?"<>|'&\x00-\x1f]/g, "").replace(/^[.\s]+|[.\s]+$/g, "");
  if (s.length > 60) s = s.slice(0, 60);
  return s || "conversation";
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
async function newFolder(outRoot, base) {
  let dir = path.join(outRoot, `${base}-${stamp()}`);
  for (let i = 2; ; i++) {
    try { await mkdir(dir, { recursive: false }); return dir; }
    catch (e) { if (e.code !== "EEXIST") throw e; dir = path.join(outRoot, `${base}-${stamp()}-${i}`); }
  }
}
function recMinutes(rec) {
  if (!rec) return Infinity;
  if (rec === "刚刚") return 0;
  const m = rec.match(/^(\d+)\s*(秒|分钟|分|小时|天|日|周|月|年)/);
  if (!m) return Infinity;
  const unit = { "秒": 1 / 60, "分钟": 1, "分": 1, "小时": 60, "天": 1440, "日": 1440, "周": 10080, "月": 43200, "年": 525600 }[m[2]];
  return +m[1] * unit;
}
function dice(a, b) {
  const na = a.toLowerCase().replace(/\s+/g, ""), nb = b.toLowerCase().replace(/\s+/g, "");
  if (na === nb) return na ? 1 : 0;
  const A = new Set(), B = new Set();
  for (let i = 0; i < na.length - 1; i++) A.add(na.slice(i, i + 2));
  for (let i = 0; i < nb.length - 1; i++) B.add(nb.slice(i, i + 2));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function matchSession(sessions, query) {
  const nq = query.toLowerCase().replace(/\s+/g, "");
  const scored = sessions.map((s) => {
    const ns = s.name.toLowerCase().replace(/\s+/g, "");
    let score;
    if (ns === nq) score = 1;
    else if (ns.includes(nq) || nq.includes(ns))
      score = 0.9 + 0.05 * (Math.min(ns.length, nq.length) / Math.max(ns.length, nq.length, 1));
    else score = dice(ns, nq);
    return { ...s, score };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0], second = scored[1];
  const ok = !!best && best.score >= 0.55 && (!second || second.score < 0.5 || best.score - second.score >= 0.12);
  return { ok, best, top: scored.slice(0, 5).map((s) => ({ name: s.name, rec: s.rec, score: +s.score.toFixed(3) })) };
}
async function readState() {
  try { return JSON.parse(await readFile(statePath(), "utf8")); } catch { return null; }
}
async function writeState(st) {
  await mkdir(path.dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(st, null, 2), "utf8");
}
// export 出口仅为离线单测：normParams 的 formats 白名单/默认值回退是纯函数
export function normParams(cfg) {
  const formats = Array.isArray(cfg.formats) && cfg.formats.length
    ? cfg.formats.filter((f) => ["html", "pdf", "longpdf", "longpng", "longjpg"].includes(f))
    : ["html", "pdf"];
  return {
    theme: THEME_MAP[cfg.theme] ? cfg.theme : "default",
    fontSize: [12, 14, 16, 18].includes(+cfg.fontSize) ? +cfg.fontSize : 14,
    pageMargin: [8, 14, 24].includes(+cfg.pageMargin) ? +cfg.pageMargin : 14,
    orientation: cfg.orientation === "landscape" ? "landscape" : "portrait",
    grayscale: !!cfg.grayscale,
    formats: formats.length ? formats : ["html", "pdf"],
    longWidth: [1024, 1280, 1600].includes(+cfg.longWidth) ? +cfg.longWidth : 1280,
    cropSides: cfg.cropSides !== false,
  };
}
// 表现参数（字号/留白/横版）→ 注入 CSS。提取时烘焙进产物的 <style id="zparams"> 块，
// 参数变更重跑 extract 被 skip 时也用它离线同步旧产物（见 extract 相位 skip 分支）
function paramsCss(P) {
  let css = "";
  if (P.fontSize !== 14) css += "html{--ui-font-size:" + P.fontSize + "px !important;}";
  if (P.pageMargin !== 14) css += "body{padding:" + P.pageMargin + "px !important;}";
  if (P.orientation === "landscape") css += "@page{size:A4 landscape;margin:10mm 0;}";
  return css;
}
// 离线把 <style id="zparams"> 块同步为目标 CSS（文件级、不碰活页面）。
// 返回是否实际改写了文件。旧产物没有该块时按需注入/移除；文件读不到（被
// render 相位删除、手动清理）返回 false 不抛错
async function syncParamsBlock(file, css) {
  const html = await readFile(file, "utf8").catch(() => null);
  if (html == null) return false;
  const block = css ? '<style id="zparams">' + css + "</style>" : "";
  const re = /[ \t]*<style id="zparams">[\s\S]*?<\/style>/;
  let next;
  if (re.test(html)) next = block ? html.replace(re, () => block) : html.replace(re, "");
  else if (block) next = injectAtEnd(html, block);
  else return false;
  if (next === html) return false;
  await writeFile(file, next, "utf8");
  return true;
}
// 对状态里已存在、且不在本次重建名单里的主题 HTML（连同 .full-html pristine）
// 离线同步参数样式。skip 分支与"增量补第二主题"路径共用，保证双主题排版一致
async function syncExistingParams(st, css, exclude = new Set()) {
  const resynced = [];
  const seen = new Set();
  for (const key of ["longHtml", "pdfHtml"]) {
    const f = st.files?.[key];
    if (!f || seen.has(f) || exclude.has(f)) continue;
    seen.add(f);
    const targets = [f];
    const pristine = path.join(st.folder, ".full-html", path.basename(f));
    if (await readFile(pristine, "utf8").then(() => true, () => false)) targets.push(pristine);
    for (const t of targets)
      if (await syncParamsBlock(t, css)) resynced.push(t);
  }
  return resynced;
}
// 增量补第二主题时，先产出的一份当时 altFile 为空、缺主题切换按钮——离线补齐
async function ensureThemeToggle(file, altBase, dark) {
  const html = await readFile(file, "utf8");
  // 判重必须用完整前缀：正文转义文本（&lt;button id="themeToggleBtn"&gt;）同样含
  // id="themeToggleBtn" 子串——按子串判会误判"已有按钮"、静默跳过补齐（踩坑清单
  // "防重复检查被聊天正文误命中"同款）。"<" 在文本与转义正文里都不裸出现，前缀判安全
  if (html.includes('<button id="themeToggleBtn"')) return false;
  const btn = '<button id="themeToggleBtn" onclick="location.href=\'' + altBase +
    '\'" style="position:fixed;top:10px;right:10px;z-index:99999;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;' +
    (dark ? "background:#2a2a2a;color:#eee;border:1px solid #555;" : "background:#fff;color:#333;border:1px solid #ccc;") + '">' +
    (dark ? "☀ 浅色" : "🌙 深色") + "</button>";
  await writeFile(file, injectAtEnd(html, btn), "utf8");
  return true;
}
// ---------- 轮次筛选（部分导出） ----------
export function turnListText(manifest) {
  // 圈号单双两套样式 + 隔行缩进，与会话列表排版一致；>20 轮退回 #N
  const circled = (n, filled) => String.fromCodePoint(filled ? (n <= 10 ? 0x2775 + n : 0x24e0 + n) : 0x245f + n);
  return manifest.map((t, i) => {
    const n = i + 1;
    const num = n <= 20 ? circled(n, n % 2 === 0) : "#" + n;
    return (n % 2 === 0 ? "  " : "") + num + " " + (t.user ? "👤" : "🤖") + " " + (t.text || "（无文本预览）");
  }).join("\n");
}
function turnsAskFor(manifest) {
  return {
    question: "导出哪些轮次？共 " + manifest.length + " 轮（👤 含提问的一轮 / 🤖 仅回复或系统轮）：\n" +
      turnListText(manifest) +
      "\n（\"其他\"输入序号可多选：2,5-7；支持 ③、3-、-6、最后N轮、全部）",
    header: "选择轮次",
    options: [
      { label: "全部对话（默认）", description: "不过滤，导出整个会话" },
      { label: "最后 1 轮", description: "只导出最后一组问答" },
      { label: "最后 3 轮", description: "最近 3 组问答" },
    ],
    note: "AskUserQuestion 拿到答案后跑 filter 相位：全部对话→turns=\"all\"（或不跑 filter）；" +
      "最后 1/3 轮→turns=\"last1\"/\"last3\"；\"其他\"输入的序号串原样传 turns（如 \"2,5-7\"）",
  };
}
export function parseTurnSpec(spec, total) {
  // 语法：all/全部；last N/最后N轮/最近N轮；序号串 2,5-7（圈号③、开区间 3- 与 -6、中文逗号顿号均可）
  const t = String(spec || "").trim();
  if (!t) throw new Error("turns 为空（可选：all/全部 | last N | 序号串如 2,5-7）");
  if (/^all$/i.test(t) || /^(全部|整个|全部轮次|整个会话)$/.test(t)) return { all: true };
  let m = t.match(/^(?:last|最后|最近)\s*(\d+)\s*轮?$/i);
  if (m) {
    const n = Math.max(1, Math.min(+m[1], total));
    const keep = new Set();
    for (let i = total - n; i < total; i++) keep.add(i);
    return { keep };
  }
  const circ = (s) => {
    const c = String(s).trim().codePointAt(0);
    if (c >= 0x2460 && c <= 0x2473) return c - 0x245f;
    if (c >= 0x2776 && c <= 0x277f) return c - 0x2775;
    if (c >= 0x24eb && c <= 0x24f4) return c - 0x24e0;
    return null;
  };
  const one = (s) => (/^\d+$/.test(s) ? +s : circ(s));
  const keep = new Set();
  for (const part0 of t.split(/[,，、;；\s]+/)) {
    const part = part0.trim();
    if (!part) continue;
    const seg = part.split(/[-–—~～]+/).map((x) => x.trim());
    if (seg.length === 1) {
      const a = one(seg[0]);
      if (!Number.isInteger(a) || a < 1 || a > total)
        throw new Error("轮次序号越界: " + part0 + "（合法 1-" + total + "）");
      keep.add(a - 1);
    } else if (seg.length === 2) {
      const lo = seg[0] ? one(seg[0]) : 1;
      const hi = seg[1] ? one(seg[1]) : total;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > total || lo > hi)
        throw new Error("轮次区间无效: " + part0 + "（合法 1-" + total + "）");
      for (let i = lo; i <= hi; i++) keep.add(i - 1);
    } else throw new Error("无法解析轮次: " + part0);
  }
  if (!keep.size) throw new Error("轮次选择为空");
  return { keep };
}
export function filterTurnsInHtml(html, keepSet) {
  // 删除未选轮次的 <!--ZTURN:i:s-->…<!--ZTURN:i:e--> 跨度：提取时标记包住
  // "只含该轮次的最高祖先"（整棵子树 + 两枚注释），删除后 HTML 必然平衡
  const re = /<!--ZTURN:(\d+):s-->[\s\S]*?<!--ZTURN:\1:e-->/g;
  let total = 0, kept = 0, droppedBytes = 0;
  const out = html.replace(re, (mm, i) => {
    total++;
    if (keepSet.has(+i)) { kept++; return mm; }
    droppedBytes += mm.length;
    return "";
  });
  if (!total) return { ok: false, reason: "no-markers" };
  return { ok: true, html: out, total, kept, droppedBytes };
}
async function applyTurnFilter(st, file, keepArr, fresh) {
  // 主文件始终放"当前应交付"版本；.full-html/ 备份未过滤全量——改选时从它重滤，
  // 不必重新提取。fresh=主文件刚落盘、还是全量（extract 后或首次 filter）
  const fullDir = path.join(st.folder, ".full-html");
  const pristine = path.join(fullDir, path.basename(file));
  await mkdir(fullDir, { recursive: true });
  const pristineExists = await readFile(pristine, "utf8").then(() => true, () => false);
  if (fresh || !pristineExists)
    await writeFile(pristine, await readFile(file, "utf8"), "utf8");
  const r = filterTurnsInHtml(await readFile(pristine, "utf8"), new Set(keepArr));
  if (!r.ok) return r;
  await writeFile(file, r.html, "utf8");
  st.filteredKeep = keepArr;
  return r;
}

// ---------- 浏览器 ----------
async function getTab(browser, cfg) {
  const u = new URL(cfg.url);
  const sid = u.searchParams.get("sid");
  if (!sid) throw new Error("URL 缺少 sid 参数");
  const tabs = await browser.tabs.list();
  const info = tabs.find((t) => (t.url || "").includes("sid=" + sid));
  if (info) return { tab: await browser.tabs.get(info.id), sid, origin: u.origin, openedNew: false };
  const tab = await browser.tabs.new();
  await tab.goto(cfg.url);
  await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
  return { tab, sid, origin: u.origin, openedNew: true };
}
const PAGE_VIEW = `(() => {
  const h1 = document.querySelector("h1");
  const h1t = h1 ? (h1.textContent || "") : "";
  // app 3.16.2 登录门：裸 sid 链接不再直接进控制页，必须选平台 OAuth 且与桌面端同一账号。
  // 判据用 h1 文案 + 平台按钮双信号，避免聊天正文提到这些词时误判
  const loginGate = /登录后继续使用\\s*Web\\s*远程控制/.test(h1t) ||
    [...document.querySelectorAll("button")].some((b) =>
      /连接\\s*(Z\\.ai|BigModel)\\s*继续使用/.test((b.textContent || "").replace(/\\s+/g, " ")));
  const kicked = /已被其他设备接管|在其他设备/.test(h1t);
  // 桌面端离线/等待配对/手机连接已失效都是断连（h1 提示 + 重新连接按钮），与被接管同样阻断提取。
  // "连接已失效"系现场实测补充：页面重载后中继直接判死，页面上点"重新连接"无效，
  // 须手机端/客户端侧恢复——必须当断连处理，不能盲跑提取克隆出 0 轮次壳
  const offline = /已离线|等待桌面端|连接已失效|等待配对/.test(h1t);
  const reconnect = [...document.querySelectorAll("button")]
    .find((b) => (b.textContent || "").trim() === "重新连接");
  // app 3.16.2：侧栏常驻任务列表，条目是 [data-testid^="task-item-"] 的 LI；
  // 旧版"打开任务 X"aria-label 按钮已不存在
  const listBtns = document.querySelectorAll('[data-testid^="task-item-"]').length;
  return { kicked: kicked || offline, loginGate, hasReconnect: !!reconnect, listBtns, turns: document.querySelectorAll("[data-v4-turn-unit]").length, title: document.title };
})()`;
const PAGE_SESSIONS = `(() => {
  // app 3.16.2 侧栏任务条目结构（实测）：
  //   LI[data-testid^="task-item-"]
  //    └ 标题 p > span.task-title-marquee-track > span（跑马灯有两份拷贝，取第一份）
  //    └ 次行 div > div > span.truncate = 项目名；div.ml-auto span.mr-1 = 相对时间
  const out = [];
  document.querySelectorAll('[data-testid^="task-item-"]').forEach((el) => {
    const titleEl = el.querySelector(".task-title-marquee-track > span");
    const name = titleEl ? (titleEl.textContent || "").trim() : "";
    if (!name) return;
    const projEl = el.querySelector("span.truncate");
    const timeEl = el.querySelector("div.ml-auto span.mr-1");
    out.push({ name, rec: timeEl ? (timeEl.textContent || "").trim() : "",
               proj: projEl ? (projEl.textContent || "").trim() : "",
               tid: el.getAttribute("data-testid") });
  });
  return out;
})()`;
const PAGE_ACTIVE = `(() => {
  // 页面上"当前打开的会话"（app 3.16.x 实测）：侧栏活动条目带 bg-selected 类；
  // 主区恰有一个 [data-session-id] 与之互证（值 = 会话 id，去 task-item- 前缀即 testid）
  const item = [...document.querySelectorAll('[data-testid^="task-item-"]')]
    .find((el) => /(?:^|\\s)bg-selected(?:\\s|$)/.test(el.className || ""));
  const marked = document.querySelector("[data-session-id]");
  const tid = item ? item.getAttribute("data-testid")
    : (marked ? "task-item-" + marked.getAttribute("data-session-id") : "");
  const titleEl = item ? item.querySelector(".task-title-marquee-track > span") : null;
  return { tid, sid: marked ? marked.getAttribute("data-session-id") : "",
           title: titleEl ? (titleEl.textContent || "").trim() : "" };
})()`;
const PAGE_CLICK = `(() => {
  // 注意：node_repl 桥的 evaluate 不会自动调用函数值表达式——"函数串 + 第二参"的写法
  // 只会把函数对象序列化返回（truthy），点击从未发生（3.16.3 实测，[object Object] 实锤）。
  // 必须写成自执行 IIFE + "TID" 占位符注入，调用方 replace 后 evaluate
  const tid = "__TID__";
  const el = document.querySelector('[data-testid="' + tid + '"]');
  if (!el) return false;
  // app 3.16.2 实测：只对条目根派发单个 click 事件可能不触发导航（处理器可能等完整
  // 按压序列或挂在内层行元素）——取条目中心点的最深可见元素，派发完整
  // pointer/mouse 按压序列，任何在"最深元素→根"路径上的处理器都能收到
  const rect = el.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return false;
  const deep = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 200)) || el;
  const opts = { bubbles: true, cancelable: true, view: window,
                 clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const Ev = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    deep.dispatchEvent(new Ev(type, opts));
  }
  return true;
})()`;
async function ensureUsable(tab) {
  for (let i = 0; i < 3; i++) {
    const v = await tab.playwright.evaluate(PAGE_VIEW);
    if (v.loginGate)
      throw new Error("远程页停在登录门（app 3.16.2+ 要求与电脑端同平台同账号登录）：" +
        "请在浏览器面板里选平台完成登录（登录后自动跳回远程页），然后重跑本相位");
    if (v.kicked && v.hasReconnect) {
      await tab.playwright.evaluate(`(() => { [...document.querySelectorAll("button")]
        .find((b) => (b.textContent || "").trim() === "重新连接")?.click(); return true; })()`);
      await tab.playwright.waitForTimeout(3000);
      continue;
    }
    return v;
  }
  throw new Error("远程会话被踢且自动重连失败——请人工点一次页面上的\"重新连接\"后重跑本相位");
}
async function ensureSessionList(tab) {
  let v = await ensureUsable(tab);
  if (v.listBtns > 0) return v;
  try { await tab.cua.keypress({ keys: ["Control", "K"] }); } catch { /* 尽力而为 */ }
  await tab.playwright.waitForTimeout(1200);
  v = await ensureUsable(tab);
  return v;
}

// ---------- 从 extract-evaluate.js 切片复用 ----------
function scanBalanced(code, from) {
  let depth = 0, j = from, inS = null, inLC = false, inBC = false;
  for (; j < code.length; j++) {
    const c = code[j], n = code[j + 1];
    if (inLC) { if (c === "\n") inLC = false; continue; }
    if (inBC) { if (c === "*" && n === "/") { inBC = false; j++; } continue; }
    if (inS) { if (c === "\\") { j++; continue; } if (c === inS) inS = null; continue; }
    if (c === "/" && n === "/") { inLC = true; j++; continue; }
    if (c === "/" && n === "*") { inBC = true; j++; continue; }
    if (c === "'" || c === '"' || c === "`") { inS = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("切片括号不匹配 @" + from);
  return j;
}
function sliceToNeedle(code, name, needle) {
  const idx = code.indexOf("const " + name + " =");
  if (idx === -1) throw new Error("extract-evaluate.js 缺少 " + name);
  const end = code.indexOf(needle, idx);
  if (end === -1) throw new Error(name + " 切片结尾标记缺失");
  return code.slice(idx, end + needle.length);
}
function sliceConstArrow(code, name) {
  const idx = code.indexOf("const " + name + " =");
  if (idx === -1) throw new Error("extract-evaluate.js 缺少 " + name);
  return code.slice(idx, scanBalanced(code, code.indexOf("{", idx)) + 1) + ";";
}
function sliceFnDecl(code, name) {
  let idx = code.indexOf("function " + name + "(");
  if (idx === -1) throw new Error("extract-evaluate.js 缺少 " + name);
  const start = idx >= 6 && code.slice(idx - 6, idx) === "async " ? idx - 6 : idx;
  return code.slice(start, scanBalanced(code, code.indexOf("{", idx)) + 1);
}
async function loadExtractor(skillDir) {
  const src = await readFile(path.join(skillDir, "extract-evaluate.js"), "utf8");
  const t0 = src.indexOf("evaluate(`");
  if (t0 === -1) throw new Error("extract-evaluate.js: 找不到主 evaluate 模板");
  const rawStart = t0 + "evaluate(`".length;
  const end = src.indexOf("})()`);", rawStart);
  if (end === -1) throw new Error("extract-evaluate.js: 找不到模板结尾");
  const raw = src.slice(rawStart, end + 4);
  // 前置探测片段（等稳定/滚动穿透已移出主 evaluate——app 3.16.2 实测内嵌等待会破桥 32s）
  const p0 = src.indexOf("const PREP_SNIPPET = `");
  if (p0 === -1) throw new Error("extract-evaluate.js: 缺少 PREP_SNIPPET");
  const prepStart = p0 + "const PREP_SNIPPET = `".length;
  const prepEnd = src.indexOf("`;", prepStart);
  if (prepEnd === -1) throw new Error("extract-evaluate.js: PREP_SNIPPET 结尾标记缺失");
  const prepSnippet = src.slice(prepStart, prepEnd);
  const cook = new Function("ORIGIN", "FORCE_THEME", "ALT_FILE", "SHADOW_HOSTS", "DUAL", "ALT_PAIR",
    "return `" + raw + "`;");
  const maker = new Function("tab", "FORCE_THEME",
    sliceToNeedle(src, "fetchChunk", "\n);") + "\n" + sliceConstArrow(src, "nodeSum") + "\n" +
    sliceFnDecl(src, "fetchRange") + "\n" + sliceConstArrow(src, "forceLDNode") +
    "\n; return { fetchRange, nodeSum, forceLDNode };");
  return { cook, maker, prepSnippet };
}
// 内嵌工具（复选框选轮次 → PNG/PDF）源码缓存；缺文件时静默跳过注入
let TOOLS_SRC = null;
async function loadToolsSrc(skillDir) {
  if (TOOLS_SRC !== null) return TOOLS_SRC;
  TOOLS_SRC = await readFile(path.join(skillDir, "export-tools.js"), "utf8").catch(() => "");
  return TOOLS_SRC;
}
async function extractOnce(tab, { extractor, origin, builds, shadowHosts, injectCss, toolsSrc, targetTid }) {
  // 每次尝试前先确保目标会话在页面上打开（桌面端切走→远程页刷新回主页/切到别的会话后，
  // 按钉扎的 tid 自动重开——导出不再依赖用户停留在目标对话上）。
  // 就绪判据必须是"活动会话 tid === 目标 tid"而非 turns>0：重开点击后旧会话尚在、
  // SPA 换装需 1~3s，只看 turns 会立刻放行、克隆跑在旧会话上导错内容（3.16.3 实测两次连错）
  if (targetTid) {
    const countTurns = `(() => document.querySelectorAll("[data-v4-turn-unit]").length)()`;
    const readState = async () => ({ act: await tab.playwright.evaluate(PAGE_ACTIVE),
                                     turns: await tab.playwright.evaluate(countTurns) });
    let s = await readState();
    if (!(s.turns > 0 && s.act.tid === targetTid)) {
      const clicked = await tab.playwright.evaluate(PAGE_CLICK.replace('"__TID__"', JSON.stringify(targetTid)));
      if (!clicked) throw new Error("目标会话条目已不在侧栏（列表变了）——重跑 plan 或 extract");
      let ready = false;
      for (let i = 0; i < 40; i++) {
        await tab.playwright.waitForTimeout(1000);
        s = await readState();
        if (s.turns > 0 && s.act.tid === targetTid) { ready = true; break; }
      }
      if (!ready) throw new Error("点击会话后 40s 内未确认目标会话打开（活动会话不符）——常见原因是桌面端切走会话导致远程页刷新；稍候自动重试，持续失败请停留在目标对话后重跑 extract");
    }
  }
  // builds: [{ theme, outFile, altFile }]；>1 = 双主题一次流水线
  // （活页面采集/稳定等待/克隆只做一遍，同一批图片共享 dataURL 缓存）
  const dual = builds.length > 1;
  const altOf = (th) => (builds.find((b) => b.theme === th) || {}).altFile || "";
  // A0/A0.5 前置（app 3.16.2 起移出主 evaluate）：稳定轮询 + 懒加载穿透由 Node 侧逐发
  // 驱动（每发亚秒级，不占桥 32s 预算），语义与原页内循环一致。
  // 页面被 WS 重同步重载时 stab 的 scrollH 会归零重来——与重试逻辑兼容
  const prepCall = (mode) => tab.playwright.evaluate(
    extractor.prepSnippet.replace('"__MODE__"', JSON.stringify(mode)));
  const prep = await prepCall("prep");
  if (!prep || !prep.found)
    throw new Error("提取到 0 个轮次——页面未显示对话（停在会话列表或别的会话？）先打开目标对话再重跑 extract");
  let stable = false, prevH = -1;
  for (let i = 0; i < 14; i++) {
    const s = await prepCall("stab");
    if (s && s.scrollH === prevH && s.scrollH > 300) { stable = true; break; }
    if (s) prevH = s.scrollH;
    await new Promise((r) => setTimeout(r, 1500));
  }
  { // 懒加载穿透：逐步滚到底（IntersectionObserver 只有真实滚动能触发），回顶再等高度稳定
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
  const pageCode = extractor.cook(origin, builds[0].theme, builds[0].altFile || "", shadowHosts,
    // DUALF 坑：模板侧 `if (DUALF)` 直接真值判断——传 "0" 是非空字符串、恒为真，
    // 单主题提取会被当成双主题跑（__zexport 变 dual 形状、返回值无顶层 len/sum，
    // 传输循环零次迭代 → "整串校验失败"必现）。单主题必须传空串（假值）
    dual ? "1" : "", { dark: altOf("dark"), light: altOf("light") });
  const exported = await tab.playwright.evaluate(pageCode);
  if (!exported || exported.err) throw new Error("提取失败: " + JSON.stringify(exported));
  if (!exported.ok) throw new Error("提取返回异常");
  exported.stable = stable; // 稳定性改由 driver 前置轮询测得（见上），页内不再自带
  if (!exported.turns)
    throw new Error("提取到 0 个轮次——页面未显示对话（停在会话列表或别的会话？）先打开目标对话再重跑 extract");
  const { fetchRange, nodeSum, forceLDNode } = extractor.maker(tab, builds[0].theme);
  // 传输元数据不从大 evaluate 返回值取，改为传输前单独小 evaluate 在页面里现算。
  // 背景（本会话实测）：分块校验全绿、整串校验三连挂，桥接往返实验证明传输层干净
  // （4MB 已知内容零损坏）——唯一自洽解释是传输期间 window.__zexport 缓冲被整体
  // 替换：分块哈希是"取块时页面侧现算、随数据同行"的，缓冲被换后每块依然自洽。
  // 处置：整串不符时落盘现场证据（transfer-debug.json），解码验证通过就放行——
  // 逐块页面侧哈希 + 解码验证 + 后续 layout-check/PDF 交叉核对仍独立兜底完整性
  const dbg = { at: new Date().toISOString(), meta: [], chunks: [], whole: [] };
  const bufStat = () => tab.playwright.evaluate(`(() => {
    const s = window.__zexport && window.__zexport.html;
    if (!s) return { gone: true };
    const h = (str) => { let x = 0; for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0; return x >>> 0; };
    return { len: s.length, head: h(s.substr(0, 4096)), tail: h(s.substr(-4096)) };
  })()`);
  const oneShotHtml = (key) => tab.playwright.evaluate(`(() => {
    if (!window.__zexport) return { err: "no __zexport" };
    const src = ${key ? "window.__zexport.dual[" + JSON.stringify(key) + "].html" : "window.__zexport.html"};
    let h = 0;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
    return { t: src, s: h >>> 0, n: src.length };
  })()`);
  const CHUNK = 1048576;
  const htmlOf = {};
  for (const b of builds) {
    // 元数据传输前现算（小 evaluate），不依赖大 evaluate 的返回值
    const dbgMeta = await tab.playwright.evaluate(`(() => {
      if (!window.__zexport) return { err: "no __zexport" };
      const one = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return { len: s.length, sum: h >>> 0 }; };
      if (window.__zexport.dual) return { dual: { dark: one(window.__zexport.dual.dark.html), light: one(window.__zexport.dual.light.html) } };
      return one(window.__zexport.html);
    })()`);
    dbg.meta.push({ theme: b.theme, dbgMeta, exportedLen: exported.len, exportedSum: exported.sum });
    const meta = dual ? (dbgMeta.dual || {})[b.theme] : dbgMeta;
    if (!meta || meta.err || typeof meta.len !== "number")
      throw new Error("缓冲元数据不可用：" + JSON.stringify(dbgMeta).slice(0, 200));
    // 单发取回：整串一次 evaluate 拿回（桥接实测 4MB/151ms 零损坏；真正的故障源
    // 是页面在提取后被 WS 重同步重载、__zexport 随文档销毁——往返次数越少越稳）
    let html = null, enc = null;
    try {
      const r = await oneShotHtml(dual ? b.theme : undefined);
      dbg.oneShot = { ok: !!(r && r.t), n: r && r.n, err: r && r.err };
      if (r && !r.err && r.t && r.n === meta.len && r.s === nodeSum(r.t)) enc = r.t;
    } catch (e) { dbg.oneShot = { threw: String(e && e.message).slice(0, 200) }; }
    if (enc) { try { html = decodeURIComponent(enc); } catch { html = null; } }
    if (!html) {
      // 兜底：分块取回。分块哈希是"取块时页面侧现算、随数据同行"的，缓冲中途被换
      // 时每块依然自洽——整串不符但解码验证通过（doctype 在、体量合理）就放行，
      // 完整性由 layout-check 与 PDF 交叉核对独立兜底；证据落盘供分析
      let enc2 = "";
      for (let off = 0; off < meta.len; off += CHUNK) {
        enc2 += await fetchRange(off, Math.min(CHUNK, meta.len - off), dual ? b.theme : undefined);
        dbg.chunks.push({ off, stat: await bufStat() });
      }
      const lenOk = enc2.length === meta.len, sumOk = nodeSum(enc2) === meta.sum;
      dbg.whole.push({ theme: b.theme, lenOk, sumOk, encLen: enc2.length, metaLen: meta.len });
      const dec = (() => { try { return decodeURIComponent(enc2); } catch { return null; } })();
      if (!lenOk || !sumOk) {
        try {
          await writeFile(path.join(fileURLToPath(new URL(".", import.meta.url)), "transfer-debug.json"),
            JSON.stringify(dbg, null, 2), "utf8");
        } catch { /* 证据落盘失败不阻断 */ }
      }
      if (!dec || dec.length < 20000 || !/<!doctype html|<html/i.test(dec.slice(0, 200)))
        throw new Error("分块取回解码验证不过（theme " + b.theme + " lenOk=" + lenOk + " sumOk=" + sumOk + "）");
      html = dec;
    }
    htmlOf[b.theme] = html;
  }
  const files = [];
  let bytes = 0;
  for (const b of builds) {
    let html = htmlOf[b.theme];
    // 与 extract-evaluate.js Node 侧一致的两行作用域替换（style 属性 + <style> 块）
    html = html.replace(/(<[a-zA-Z][^>]*?\sstyle=")([^"]*)(")/g,
      (m, pre, val, post) => pre + forceLDNode(val, b.theme).replace(/url\((["']?)\/(?!\/)/g, "url($1" + origin + "/") + post);
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, (m) => forceLDNode(m, b.theme));
    // 站点 UI 给消息区加滚动渐隐 mask：3.14 是 message-layer 行内固定 550px 渐隐；
    // 3.16 改为滚动驱动（随 scrollTop 往容器行内写 maskImage/maskPosition/maskSize，
    // 目标元素不限于 message-layer）并新增 Tailwind [mask-image:…] 工具类。静态克隆后
    // 一律变成永久渐隐截断（mask 不改布局高度：页数正常、栅格空洞检测不报，极隐蔽）。
    // 剥全部元素的内联 mask（先剥 -webkit- 变体防止残留悬挂前缀）+ 注入兜底 CSS：
    // 类级 mask 用 [class*=mask-image] 中和（同为 !important 时比源顺序，注入块在文档
    // 末尾必胜）；同时解锁用户提问气泡的 max-height 折叠
    html = html.replace(/(<[^>]*?\sstyle="[^"]*?)-webkit-mask-image:[^;"]*;?/g, "$1");
    html = html.replace(/(<[^>]*?\sstyle="[^"]*?)mask-image:[^;"]*;?/g, "$1");
    html = injectAtEnd(html,
      '<style id="zfix-mask">[data-v4-timeline-message-layer],[class*="mask-image"]{mask-image:none!important;' +
      '-webkit-mask-image:none!important}[data-v4-user-input-collapsible-content]{max-height:none!important}</style>');
    // 宽表格打印裁切修复：站点表格带 w-max（width:max-content，实测 1136px）且外层
    // 包装 div 带内联 max-width:848px（屏幕栏宽），屏幕上靠容器横向滚动是设计内，
    // 打印媒体下右半边会被页边直接裁掉（A4 PDF/长页 PDF 都中招，实测「原因」列整列
    // 截断）。打印时表格与"包含表格的 div"一律收进容器宽并允许单元格折行；
    // 屏幕媒体不动（保网页还原）。:has() 需 Chromium 105+（本流程 Edge 154+，无虞）
    // 注意 overflow-wrap 必须用 anywhere 而非 break-word：break-word 不参与表格
    // min-content 宽度计算，表格仍会撑到 max-content（实测 1057px > 容器 668px）
    // 而被滚动容器裁掉最右一列；anywhere 才会真正让表格收进容器宽。
    html = injectAtEnd(html,
      '<style id="zfix-print-table">@media print{table{width:100%!important;max-width:100%!important}' +
      'div:has(table){max-width:100%!important}td,th{overflow-wrap:anywhere}}</style>');
    // 导出参数注入（字号/留白/横版）：<style id="zparams"> 块锚在文档末尾——
    // 既有样式全在 head，后置取胜；块身份固定，skip 复用时离线整体替换
    if (injectCss) html = injectAtEnd(html, '<style id="zparams">' + injectCss + "</style>");
    // 内嵌工具注入（复选框选轮次 → PNG/PDF）：防重复检查必须用完整标签——
    // 对话正文可能转义地"提到" data-ztools 等标记名（聊的就是这个工具）
    if (toolsSrc && !html.includes("<script data-ztools>"))
      html = injectAtEnd(html, "<script data-ztools>" + toolsSrc + "</script>");
    await mkdir(path.dirname(b.outFile), { recursive: true });
    await writeFile(b.outFile, "<!doctype html>\n" + html, "utf8");
    files.push(b.outFile);
    bytes += html.length;
  }
  await tab.playwright.evaluate(`(() => { delete window.__zexport; return true; })()`);
  return { files, bytes, turns: exported.turns, hostsFlattened: exported.hostsFlattened,
           blobs: exported.blobs, stable: exported.stable, crossOrigin: exported.crossOrigin,
           fffdLive: exported.fffdLive, turnsMarked: exported.turnsMarked,
           turnsMetaEnc: exported.turnMeta, toolsInjected: !!toolsSrc };
}

// ---------- 渲染 ----------
// Windows 上 Python 子进程的管道编码取区域设置（中文系统 cp936 编不了 emoji）——
// 会话名里的 emoji 进入产物路径后，py 脚本 print 路径会直接 UnicodeEncodeError。
// 全部 execFile 统一注入 PYTHONIOENCODING；py 脚本内另有 reconfigure 兜底手动执行
const PY_ENV = { ...process.env, PYTHONIOENCODING: "utf-8" };
const runRender = (renderPy, html, outDir, extraArgs) => new Promise((resolve, reject) => {
  execFile("python", [renderPy, html, "--out-dir", outDir, ...extraArgs],
    // 超时须 > render.py 内部 Edge 超时（300s）+ taskkill /T 余量，否则 driver 先杀
    // python（Windows TerminateProcess），孤儿 Edge 与临时 profile 会残留堆积
    { windowsHide: true, timeout: 330000, maxBuffer: 16 * 1024 * 1024, env: PY_ENV },
    (err, stdout, stderr) => {
      if (err) reject(new Error("render.py 失败: " + String(stderr || stdout || err.message).slice(-600)));
      else resolve(String(stdout).trim().split("\n").pop());
    });
});
const toJpg = (png, jpg) => new Promise((resolve, reject) => {
  const py = "from PIL import Image; import sys; im = Image.open(sys.argv[1]).convert('RGB'); im.save(sys.argv[2], 'JPEG', quality=88); print('ok')";
  execFile("python", ["-c", py, png, jpg],
    { windowsHide: true, timeout: 120000, env: PY_ENV }, (err, so, se) =>
    err ? reject(new Error("JPG 转换失败: " + String(se || err.message).slice(-300))) : resolve(jpg));
});

// ---------- 相位 ----------
export async function runPhase(phase, override = {}) {
  const cfg = { ...DEFAULTS, ...override };
  if (!cfg.skillDir) cfg.skillDir = fileURLToPath(new URL(".", import.meta.url));
  if (cfg.url) cfg.url = cfg.url.trim();
  // 注意：本模块运行在真实 Node 域，看不到 cell 沙箱的全局 agent——
  // browser 句柄必须由调用方 cell（先 setupBrowserRuntime）通过参数传入。
  const browser = cfg.browser;
  if ((phase === "open" || phase === "plan" || phase === "extract") && !browser)
    throw new Error(phase + " 相位需要 browser 参数：cell 顶层先跑 setupBrowserRuntime，再 runPhase('" + phase + "', { ..., browser: await agent.browsers.get('iab') })");

  if (phase === "open") {
    // 标准入口：只连接 + 探活，然后停。会话选择权完全交给用户（页面上自己点开），
    // agent 转告用户等待"开始"指令——零会话匹配、零参数询问（v2 流程）
    if (!cfg.url) cfg.url = await urlFromStore();
    if (!cfg.url)
      throw new Error("open 需要 url（或把远程链接存到 " + REMOTE_URL_FILE + " 的首条非注释行，驱动会自动读取）");
    await mkdir(cfg.outRoot, { recursive: true });
    const { tab, sid, origin, openedNew } = await getTab(browser, cfg);
    // 远程链接不落状态文件（保密约定）：只存 sid/origin/参数等非敏感字段，
    // 后续相位用时从私密 store 现读或由 sid 重构
    const st = { cfg: { sid, origin, outRoot: cfg.outRoot, skillDir: cfg.skillDir,
                        composerText: cfg.composerText },
                 params: normParams(cfg), createdAt: Date.now() };
    await ensureUsable(tab);
    await writeState(st);
    return { status: "waiting", openedNew,
             note: "页面已打开并探活。请用户在页面上点开要导出的对话，然后在聊天里发\"开始\"；" +
                   "随后依次跑 extract({ browser, session:\"当前\" }) → render → verify，全程不再询问" };
  }

  if (phase === "plan") {
    if (!cfg.url) cfg.url = await urlFromStore();
    if (!cfg.url)
      throw new Error("plan 需要 url（或把远程链接存到 " + REMOTE_URL_FILE + " 的首条非注释行，驱动会自动读取）");
    await mkdir(cfg.outRoot, { recursive: true });
    const { tab, sid, origin, openedNew } = await getTab(browser, cfg);
    // 远程链接不落状态文件：%TEMP% 常驻一份 sid+hash 与"链接不进任何产物"的
    // 保密约定矛盾。后续相位用时现读（store → 调用方传参 → 由 sid+origin 重构）
    const st = { cfg: { sid, origin, outRoot: cfg.outRoot, skillDir: cfg.skillDir, maxList: cfg.maxList,
                        composerText: cfg.composerText },
                 params: normParams(cfg), createdAt: Date.now() };

    if (cfg.session === "当前" || /^(current|this)$/i.test(cfg.session)) {
      const v = await ensureUsable(tab);
      if (v.turns === 0) throw new Error("当前没有打开的对话（turns=0）——先在页面上打开目标会话，或改用会话名");
      const folder = await newFolder(cfg.outRoot, "当前会话");
      Object.assign(st, { target: "当前会话", tid: null, useCurrent: true, safe: safeName("当前会话"), folder });
      await writeState(st);
      return { status: "auto", session: "当前打开的对话", folder, openedNew };
    }
    const v = await ensureSessionList(tab);
    if (v.listBtns === 0)
      return { status: "need-list", hint: "页面上找不到任务列表（尝试 Ctrl+K 也未唤出）——请打开任务列表面板后重跑 plan，或用 \"当前\" 导出当前对话" };
    const sessions = await tab.playwright.evaluate(PAGE_SESSIONS);
    if (!sessions.length) return { status: "need-list", hint: "任务列表为空" };

    if (cfg.session) {
      const m = matchSession(sessions, cfg.session);
      if (!m.ok) return { status: "ambiguous", query: cfg.session, candidates: m.top };
      const folder = await newFolder(cfg.outRoot, safeName(m.best.name));
      Object.assign(st, { target: m.best.name, tid: m.best.tid, safe: safeName(m.best.name), folder, matchScore: +m.best.score.toFixed(3) });
      await writeState(st);
      return { status: "auto", session: m.best.name, matchScore: +m.best.score.toFixed(3), folder, openedNew };
    }
    const list = sessions.map((s, i) => ({ ...s, minutes: recMinutes(s.rec), order: i }))
      .sort((a, b) => (a.minutes - b.minutes) || (a.order - b.order))
      .slice(0, cfg.maxList)
      .map(({ name, rec, minutes, tid }) => ({ name, rec, tid, minutes: Math.round(minutes) }));
    Object.assign(st, { list });
    await writeState(st);
    // 单双序号两套圈号（奇数行白圈 ①-⑳ / 偶数行黑圈 ❶-❿⓫-⓴），偶数行再缩进两格；
    // >20 退回 #N（圈号 Unicode 只编到 20，maxList 调大时防溢出）
    const circled = (n, filled) => String.fromCodePoint(filled ? (n <= 10 ? 0x2775 + n : 0x24e0 + n) : 0x245f + n);
    const num = (n, filled) => (n <= 20 ? circled(n, filled) : "#" + n);
    const recTxt = (r) => (r === "刚刚" ? "刚刚" : r + "前");
    const listText = "最近 " + list.length + " 个会话：\n" +
      list.map((x, i) => {
        const n = i + 1;
        return (n % 2 === 0 ? "  " : "") + num(n, n % 2 === 0) + " " + x.name + "（" + recTxt(x.rec) + "）";
      }).join("\n");
    return { status: "select", sessions: list, listText, openedNew,
             note: "兜底流程：把列表展示给用户让其选择（文本输出即可，不强制 AskUserQuestion），" +
                   "再以 pick=序号或会话名跑 extract；新流程请改用 open 相位 + 用户页面自选" };
  }

  if (phase === "extract") {
    const st = await readState();
    if (!st) throw new Error("先跑 open 相位（无状态文件）");
    const sCfg = { ...cfg, ...st.cfg }; // 状态里的 cfg 优先
    // 链接不落状态：调用方传参 → 私密 store → 由状态里的 sid+origin 重构（三选一）
    if (!sCfg.url) sCfg.url = cfg.url || (await urlFromStore()) ||
      (sCfg.sid && sCfg.origin ? sCfg.origin + "/remote/v4?sid=" + sCfg.sid : "");
    if (!sCfg.url)
      throw new Error("extract 缺少远程链接（重跑 open，或把链接存到 " + REMOTE_URL_FILE + "）");
    const P = normParams({ ...(st.params || {}), ...override }); // 本次传入优先
    st.params = P;
    let target = st.target, tid = st.tid;
    // 标准入口（v2）：session/pick = "当前" → 导出页面上用户已点开的对话，
    // 不需要 plan 预先锁定。folder 在此首次落定
    if (!target && st.useCurrent)
      Object.assign(st, { target: "当前会话", safe: safeName("当前会话"),
                          folder: st.folder || await newFolder(sCfg.outRoot, safeName("当前会话")) });
    else if (!target && /^(当前|current|this)$/i.test(String(cfg.pick || cfg.session || "").trim()))
      Object.assign(st, { target: "当前会话", tid: null, useCurrent: true, safe: safeName("当前会话"),
                          folder: await newFolder(sCfg.outRoot, safeName("当前会话")) });
    target = st.target;
    if (!target) {
      if (!cfg.pick && !cfg.session) throw new Error("open 未锁定会话，extract 需要 session:\"当前\"（标准流程）或 pick（序号或会话名，兜底流程）");
      const list = st.list || [];
      let found = null;
      // 圈号序号（①⑫ ❶⓫）归一化为阿拉伯数字
      const normPick = (v) => {
        const t = String(v).trim();
        if (/^[0-9]+$/.test(t)) return t;
        const c = t.codePointAt(0);
        if (c >= 0x2460 && c <= 0x2473) return String(c - 0x245f);
        if (c >= 0x2776 && c <= 0x277f) return String(c - 0x2775);
        if (c >= 0x24eb && c <= 0x24f4) return String(c - 0x24e0);
        return t;
      };
      const pickVal = normPick(cfg.pick);
      if (/^[0-9]+$/.test(pickVal)) {
        const i = +pickVal - 1;
        if (i < 0 || i >= list.length) throw new Error("序号越界：合法范围 1-" + list.length);
        found = list[i];
      } else {
        const m = matchSession(list.map((x) => ({ ...x })), pickVal);
        if (!m.ok) return { status: "ambiguous", query: cfg.pick, candidates: m.top };
        found = m.best;
      }
      target = found.name; tid = found.tid;
      st.target = target; st.tid = tid; st.safe = safeName(target);
      st.folder = st.folder || await newFolder(sCfg.outRoot, st.safe);
    }
    const { tab } = await getTab(browser, sCfg);
    await ensureUsable(tab);

    const themes = { long: (THEME_MAP[P.theme] || THEME_MAP.default).long, pdf: (THEME_MAP[P.theme] || THEME_MAP.default).pdf };
    st.cfg.themes = themes;
    const sameTheme = themes.long === themes.pdf;
    const mainHtml = path.join(st.folder, st.safe + ".html");
    const pdfHtml = sameTheme ? mainHtml : path.join(st.folder, st.safe + (themes.pdf === "dark" ? "" : ".light") + ".html");
    const longHtml = sameTheme ? mainHtml : path.join(st.folder, st.safe + (themes.long === "dark" ? "" : ".light") + ".html");
    // 需要 pdf 主题 HTML 的两种情况：formats 含 pdf；theme=both（两套产物都要）。
    // 只要长图/HTML 时跳过第二主题——省一次完整提取流水线
    const needPdfHtml = !sameTheme && (P.formats.includes("pdf") || P.theme === "both");

    // 本次要产出的主题（已存在的跳过；姊妹链接指向"本次运行结束后是否存在"）
    const builds = [];
    if (!st.files?.longHtml)
      builds.push({ theme: themes.long, outFile: longHtml, altFile: needPdfHtml ? path.basename(pdfHtml) : "" });
    if (needPdfHtml && !st.files?.pdfHtml)
      builds.push({ theme: themes.pdf, outFile: pdfHtml, altFile: path.basename(longHtml) });
    if (!builds.length) {
      // 参数（字号/留白/横版）烘焙在产物 HTML 的 <style id="zparams"> 块里——skip 时
      // 离线同步该块，"改参数重跑 extract"不再静默复用旧排版（全程不碰活页面）
      const resynced = await syncExistingParams(st, paramsCss(P));
      await writeState(st);
      return { status: "skip",
               note: resynced.length
                 ? "所需主题 HTML 已存在：已离线更新参数样式（字号/留白/横版）——重跑 render 生效"
                 : "所需主题 HTML 已存在，复用（参数无变化）",
               files: st.files, folder: st.folder, params: P, paramsResynced: resynced };
    }

    // —— 目标钉扎与自愈（app 3.16.x 实测：桌面端切走会话，远程页即整页刷新回主页）——
    // 目标 tid 来源：plan 按名锁定的 st.tid；"当前"= 开跑时页面上正打开的会话，现读并
    // 钉入 st.pinnedTid。用户后来又换开了别的对话（turns>0）以最新动作为准重新钉扎；
    // 页面被刷新回主页（turns=0）则回退到上次钉扎的 tid 自动重开。钉扎后导出全程
    // 不依赖用户停留在页面上：每次提取尝试前核对活动会话，被切走就重新点开
    let targetTid = tid || null;
    const liveTurns = await tab.playwright.evaluate(`(() => document.querySelectorAll("[data-v4-turn-unit]").length)()`);
    if (!targetTid && liveTurns > 0) {
      const act = await tab.playwright.evaluate(PAGE_ACTIVE);
      if (act.tid) { st.pinnedTid = act.tid; st.pinnedTitle = act.title; targetTid = act.tid; }
    }
    if (!targetTid && liveTurns === 0 && st.pinnedTid) targetTid = st.pinnedTid; // 刷新回主页→按上次钉扎重开
    if (!targetTid && liveTurns === 0)
      throw new Error("页面上没有打开的对话（轮次数=0）——请先在页面上点开要导出的对话，再发\"开始\"重跑 extract");
    st.openedName = target;
    // 导出参数 → CSS 注入（<style id="zparams"> 块，文档末尾、后置 + !important 生效；
    // skip 复用时 syncParamsBlock 用同一函数离线同步）
    const injectCss = paramsCss(P);
    // 增量补第二主题时，已存在的那份也同步参数样式——否则先产的 14px、后补的 16px，
    // 双主题排版静默不一致（layout-check 逐文件检查，检不出跨文件不一致）
    const paramsResynced = await syncExistingParams(st, injectCss, new Set(builds.map((b) => b.outFile)));
    const extractor = await loadExtractor(sCfg.skillDir);
    const toolsSrc = await loadToolsSrc(sCfg.skillDir);
    if (toolsSrc && toolsSrc.includes("</scr" + "ipt>"))
      throw new Error("export-tools.js 含 </script> 序列，会截断注入");
    // 提取重试：页面会被 WS 重同步随机重载（缓冲/克隆随文档销毁，实测大 evaluate
    // 一返回缓冲就没了）。撞上就等几秒让重载落定再整轮重来，最多 3 次；
    // 确定性错误重试必然复现，立即抛出不重试
    let summary = null;
    for (let attempt = 1; attempt <= 3 && !summary; attempt++) {
      try {
        summary = await extractOnce(tab, { extractor, origin: sCfg.origin, builds,
          shadowHosts: cfg.shadowHosts || "diffs-container", injectCss, toolsSrc, targetTid });
      } catch (e) {
        // 确定性错误立即抛出：0 轮次壳（对话/列表态不对且无 tid 可恢复）、解码损坏
        // （原样重试必然复现）。缓冲丢失（"缓冲元数据不可用"）= 提取期间页面被
        // WS 重同步/桌面端切走刷新——瞬时态，等 4s 整轮重来（重开会话重提取）
        if (/提取到 0 个轮次|分块取回解码验证不过/.test(e.message)) throw e;
        if (attempt === 3) throw new Error(e.message + "（已重试" + (attempt - 1) + "次）");
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    st.files = st.files || {};
    for (const b of builds) st.files[b.theme === themes.long ? "longHtml" : "pdfHtml"] = b.outFile;
    if (sameTheme && st.files.longHtml) st.files.pdfHtml = st.files.longHtml;
    // 增量补第二主题：先产出的一份当时 altFile 为空、缺主题切换按钮——离线补齐
    const toggleFixed = [];
    if (st.files.longHtml && st.files.pdfHtml && st.files.longHtml !== st.files.pdfHtml) {
      const pairSpecs = [[st.files.longHtml, path.basename(st.files.pdfHtml), themes.long === "dark"],
                         [st.files.pdfHtml, path.basename(st.files.longHtml), themes.pdf === "dark"]];
      for (const [f, altBase, dark] of pairSpecs) {
        const exists = await readFile(f, "utf8").then(() => true, () => false);
        if (exists && await ensureThemeToggle(f, altBase, dark)) toggleFixed.push(f);
      }
    }
    // 轮次清单（两主题各回一份，取最新；同一次会话内容一致）。提取返回 percent-encode
    // 过的 ASCII 串，这里 decode 回对象数组
    if (summary.turnsMetaEnc) {
      try { st.turns = JSON.parse(decodeURIComponent(summary.turnsMetaEnc)); } catch { /* 清单损坏不致命 */ }
    }
    // 之前已设轮次筛选 → 新提取的全量立即按既有选择重滤（原始全量备份到 .full-html/）
    let refiltered = null;
    if (Array.isArray(st.filterKeep) && st.filterKeep.length) {
      refiltered = [];
      for (const f of summary.files) {
        const r = await applyTurnFilter(st, f, st.filterKeep, true);
        refiltered.push(r.ok ? { file: f, kept: r.kept, total: r.total } : { file: f, skipped: r.reason });
      }
    }
    await writeState(st);
    const warns = [];
    if (!summary.stable) warns.push("消息流未稳定：产物可能缺最新轮次");
    if (summary.crossOrigin > 0) warns.push(summary.crossOrigin + " 个跨域样式表未读取");
    if (Array.isArray(st.turns) && st.turns.length && summary.turnsMarked !== st.turns.length)
      warns.push("turnsMarked=" + summary.turnsMarked + "/" + st.turns.length + "（不等时无标记，部分导出不可用）");
    const { turnsMetaEnc, ...summaryRest } = summary;
    // 标准流程不问轮次（默认全量）。turnsAsk 只在 filter 相位未带 spec 时返回——
    // 用户明确要求部分导出但没说清哪几轮时，agent 才拿它去问
    return { status: "ok", files: summary.files, params: P, ...summaryRest, folder: st.folder, warns,
             refiltered, toggleFixed, paramsResynced };
  }

  if (phase === "filter") {
    // 部分轮次导出：turns spec 见 parseTurnSpec。未带 spec 时返回轮次清单 + 询问素材
    const st = await readState();
    if (!st?.files?.longHtml) throw new Error("先跑 extract（长图主题 HTML 缺失）");
    const manifest = Array.isArray(st.turns) ? st.turns : [];
    if (!manifest.length) throw new Error("状态里没有轮次清单——重跑一次 extract（新版提取才产出清单）");
    const spec = String(cfg.turns || "").trim();
    if (!spec) {
      return { status: "need-spec", turns: manifest, turnsAsk: turnsAskFor(manifest),
               note: "用 AskUserQuestion 向用户提问（turnsAsk.question / options），" +
                     "答案作为 turns 参数重跑 filter 相位" };
    }
    if (/^all$/i.test(spec) || /^(全部|整个|全部轮次|整个会话)$/.test(spec)) {
      const restored = [];
      const seen = new Set();
      for (const key of ["longHtml", "pdfHtml"]) {
        const f = st.files[key];
        if (!f || seen.has(f)) continue;
        seen.add(f);
        const pristine = path.join(st.folder, ".full-html", path.basename(f));
        const full = await readFile(pristine, "utf8").catch(() => null);
        if (full != null) { await writeFile(f, full, "utf8"); restored.push(f); }
      }
      st.filterKeep = null; st.filteredKeep = null; st.turnsSpec = "all";
      await writeState(st);
      await rm(path.join(st.folder, "turns.json"), { force: true }); // 恢复全量后过时筛选记录不留
      return { status: "ok", spec: "all", restored,
               note: restored.length ? "已从 .full-html 恢复全量" : ".full-html 无备份（主文件本就是全量）" };
    }
    const parsed = parseTurnSpec(spec, manifest.length);
    const keepArr = [...parsed.keep].sort((a, b) => a - b);
    const files = [];
    const seen = new Set();
    for (const key of ["longHtml", "pdfHtml"]) {
      const f = st.files[key];
      if (!f || seen.has(f)) continue;
      seen.add(f);
      // 主文件还是全量（首次 filter）→ 先备份再滤；已滤过 → 直接从 .full-html 重滤
      const r = await applyTurnFilter(st, f, keepArr, !st.filteredKeep);
      files.push(r.ok ? { file: f, total: r.total, kept: r.kept, droppedBytes: r.droppedBytes }
                      : { file: f, skipped: r.reason });
    }
    st.filterKeep = keepArr;
    st.turnsSpec = spec;
    await writeState(st);
    await writeFile(path.join(st.folder, "turns.json"),
      JSON.stringify({ spec, keep: keepArr.map((i) => i + 1), total: manifest.length, turns: manifest }, null, 2),
      "utf8");
    return { status: "ok", spec, kept: keepArr.length, total: manifest.length, files,
             folder: st.folder, note: "已按选择裁剪两主题 HTML，接着跑 render + verify；改选可直接重跑 filter（从 .full-html 重滤）" };
  }

  if (phase === "render") {
    const st = await readState();
    if (!st?.files?.longHtml) throw new Error("先完成 extract（长图主题 HTML 缺失）");
    const sCfg = { ...cfg, ...st.cfg };
    const P = normParams(st.params || {});
    const themes = st.cfg?.themes || THEME_MAP[P.theme];
    const sameTheme = themes.long === themes.pdf;
    const renderPy = path.join(sCfg.skillDir, "render.py");
    // formats 不含 pdf 且非 both 时，extract 只产长图主题一份 HTML（第二主题被跳过）
    if (!sameTheme && P.formats.includes("pdf") && !st.files.pdfHtml)
      throw new Error("先完成 extract（缺 pdf 主题 HTML）");
    const htmls = sameTheme
      ? [{ file: st.files.longHtml, theme: themes.long, work: path.join(st.folder, ".work0") }]
      : [{ file: st.files.longHtml, theme: themes.long, work: path.join(st.folder, ".work0") },
         ...(st.files.pdfHtml ? [{ file: st.files.pdfHtml, theme: themes.pdf, work: path.join(st.folder, ".work1") }] : [])];
    // formats 仅含 HTML 时不需要任何渲染产物——render.py 的 PDF+长图全流程纯属白耗
    if (!P.formats.some((f) => f !== "html")) {
      const products = { folder: st.folder, html: st.files.longHtml,
                         pdfHtml: (!sameTheme && st.files.pdfHtml) || null,
                         longPngs: [], pdfs: [], longPdfs: [], jpgs: [], pagesDir: null };
      st.products = products;
      await writeState(st);
      return { status: "ok", products, params: P, renderTails: [], pageCount: 0,
               note: "formats 仅含 HTML：跳过渲染与质检" };
    }
    const extra = ["--width", String(P.longWidth)];
    if (P.grayscale) extra.push("--grayscale");
    if (!P.cropSides) extra.push("--no-crop-sides");
    if (P.formats.includes("longpdf")) extra.push("--longpdf");
    // formats 不含长图时跳过长图渲染（超长会话长图会触顶报错，长页 PDF 不应被连坐）
    if (!P.formats.includes("longpng") && !P.formats.includes("longjpg")) extra.push("--skip-longpng");
    const tails = await Promise.all(htmls.map((h) => runRender(renderPy, h.file, h.work, extra)));
    // render.py 末行 LONGPDF JSON = 长页 PDF 元数据（mode/pages/widthCss/heightCss）
    const lpMeta = (tail) => {
      const m = /LONGPDF (\{.*)\}/.exec(String(tail || ""));
      if (!m) return null;
      try { return JSON.parse(m[1]); } catch { return null; }
    };

    const safe = st.safe;
    const pngName = (th) => (th === "dark" ? safe + "-long.png" : safe + "-light-long.png");
    const pdfName = (th) => (th === "light" ? safe + ".pdf" : safe + "-dark.pdf");
    // 长页 PDF 主题跟随长图（屏幕阅读，深色默认），命名同款 -long / -light-long 后缀
    const longPdfName = (th) => (th === "dark" ? safe + "-long.pdf" : safe + "-light-long.pdf");
    const wantLongs = P.theme === "both" ? ["dark", "light"] : [themes.long];
    const wantPdfs = P.theme === "both" ? ["light", "dark"] : [themes.pdf];
    const wantLongPdfs = P.theme === "both" ? ["dark", "light"] : [themes.long];

    const products = { folder: st.folder, html: null, pdfHtml: null, longPngs: [], pdfs: [], longPdfs: [], jpgs: [], pagesDir: path.join(st.folder, "pages") };
    if (P.formats.includes("html")) {
      products.html = st.files.longHtml;
      if (!sameTheme) products.pdfHtml = st.files.pdfHtml;
    }
    for (let hi = 0; hi < htmls.length; hi++) {
      const h = htmls[hi];
      const wantLong = wantLongs.includes(h.theme) && (P.formats.includes("longpng") || P.formats.includes("longjpg"));
      if (wantLong) {
        const dst = path.join(st.folder, pngName(h.theme));
        await rename(path.join(h.work, "conversation-long.png"), dst);
        if (P.formats.includes("longpng")) products.longPngs.push(dst);
        if (P.formats.includes("longjpg")) {
          const jpg = dst.replace(/\.png$/, ".jpg");
          await toJpg(dst, jpg);
          products.jpgs.push(jpg);
          if (!P.formats.includes("longpng")) await rm(dst, { force: true }); // 只要 JPG 时 PNG 是中间产物
        }
      }
      if (P.formats.includes("pdf") && wantPdfs.includes(h.theme)) {
        const dst = path.join(st.folder, pdfName(h.theme));
        await rename(path.join(h.work, "conversation.pdf"), dst);
        products.pdfs.push(dst);
      }
      if (P.formats.includes("longpdf") && wantLongPdfs.includes(h.theme)) {
        const srcLp = path.join(h.work, "conversation-long.pdf");
        if (!existsSync(srcLp))
          throw new Error("render.py 未产出 conversation-long.pdf（--longpdf 渲染失败？见 renderTails）");
        const dst = path.join(st.folder, longPdfName(h.theme));
        await rename(srcLp, dst);
        products.longPdfs.push({ file: dst, theme: h.theme, ...(lpMeta(tails[hi]) || {}) });
      }
    }
    // PDF 逐页 PNG 移入 pages/（验收证据）：优先取产 PDF 的那份渲染
    const pagesSrc = P.formats.includes("pdf")
      ? (htmls.find((h) => wantPdfs.includes(h.theme)) || htmls[0])
      : (htmls.find((h) => wantLongs.includes(h.theme)) || htmls[0]);
    await mkdir(products.pagesDir, { recursive: true });
    for (const f of await readdir(pagesSrc.work))
      if (/^page-\d+\.png$/.test(f)) await rename(path.join(pagesSrc.work, f), path.join(products.pagesDir, f));
    // 长页 PDF 的逐页验收预览（lp-*.png）归档到产物根目录（layout-check 栅格分析用）
    if (P.formats.includes("longpdf")) {
      const lpWork = htmls.find((h) => wantLongPdfs.includes(h.theme)) || htmls[0];
      for (const f of await readdir(lpWork.work))
        if (/^lp-\d+\.png$/.test(f)) await rename(path.join(lpWork.work, f), path.join(st.folder, f));
    }
    for (const h of htmls) await rm(h.work, { recursive: true, force: true });
    if (!P.formats.includes("html")) {
      await rm(st.files.longHtml, { force: true });
      if (st.files.pdfHtml && st.files.pdfHtml !== st.files.longHtml) await rm(st.files.pdfHtml, { force: true });
      // 文件已删，状态同步清空：否则下次 extract 误判"已存在"走 skip 分支、对着
      // 不存在的文件做离线同步直接 ENOENT（SKILL.md 承诺的"自动重滤"也不可达）
      delete st.files.longHtml;
      delete st.files.pdfHtml;
    }
    // 兼容字段（verify 用主产物）
    products.longPng = products.longPngs[0] || null;
    products.pdf = products.pdfs[0] || null;
    products.longPdf = products.longPdfs[0] || null;
    st.products = products;
    await writeState(st);
    return { status: "ok", products, params: P, renderTails: tails,
             pageCount: (await readdir(products.pagesDir)).filter((f) => f.startsWith("page-")).length };
  }

  if (phase === "verify") {
    const st = await readState();
    if (!st?.products) throw new Error("先跑 render");
    const P = normParams(st.params || {});
    const pr = st.products;
    const longFiles = [...(pr.longPngs || []), ...(pr.jpgs || [])];
    const longPdfs = pr.longPdfs || [];
    const pdfFiles = [...(pr.pdfs || []), ...longPdfs.map((x) => x.file)];
    if (!pdfFiles.length && !longFiles.length)
      return { status: "skip", note: "产物不含 PDF、长页 PDF 与长图，跳过质检", products: pr };
    const pdfList = pdfFiles.join("|");
    const py = `
import json, sys
import pymupdf
import numpy as np
from PIL import Image
pdfs = [x for x in sys.argv[1].split("|") if x and x != "-"]
pngs = [x for x in sys.argv[2].split("|") if x and x != "-"]
composer_word = sys.argv[3]
out = {"pdfs": [], "pngs": []}
for p in pdfs:
    doc = pymupdf.open(p); txt = "".join(pg.get_text() for pg in doc)
    pix = doc[0].get_pixmap(dpi=40)
    arr = np.asarray(Image.frombytes("RGB", (pix.width, pix.height), pix.samples)).astype(int)
    out["pdfs"].append({"file": p, "pages": len(doc), "fffd": txt.count("\\ufffd"),
                        "composer": composer_word in txt, "chars": len(txt),
                        "rgb": [round(float(arr[:,:,i].mean()), 1) for i in range(3)]})
for g in pngs:
    arr = np.asarray(Image.open(g).convert("RGB"))
    out["pngs"].append({"file": g, "w": int(arr.shape[1]), "h": int(arr.shape[0]), "std": round(float(arr.std()), 1)})
print(json.dumps(out, ensure_ascii=False))`;
    // composerText 优先级：本次显式传入 > plan 持久化值 > 默认。
    // （cfg 已并 DEFAULTS，区分不了"显式传默认值"，故必须先看 override 原参）
    const composerWord = override.composerText ?? (st.cfg && st.cfg.composerText) ?? cfg.composerText;
    const out = await new Promise((resolve, reject) => {
      execFile("python", ["-c", py, (pdfFiles.length ? pdfList : "-"), (longFiles.length ? longFiles.join("|") : "-"), composerWord],
        { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: PY_ENV },
        (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).slice(-400))) : resolve(stdout.trim()));
    });
    const checks = JSON.parse(out.slice(out.indexOf("{")));
    const filtered = Array.isArray(st.filterKeep) && st.filterKeep.length > 0; // 部分轮次导出
    const verdict = {
      pages_ok: checks.pdfs.every((p) => p.pages >= 1),
      no_fffd: checks.pdfs.every((p) => p.fffd === 0),
      no_composer: checks.pdfs.every((p) => !p.composer),
      has_text: checks.pdfs.every((p) => p.chars > (filtered ? 150 : 500)),
      long_not_blank: checks.pngs.every((g) => g.std > 5 && g.h > (filtered ? 300 : 1000)),
      long_width_ok: checks.pngs.every((g) => g.w === P.longWidth || P.cropSides),
    };
    if (P.grayscale) {
      verdict.grayscale_ok = checks.pdfs.every((p) => Math.max(p.rgb) - Math.min(p.rgb) < 3);
    }
    // 长页 PDF：single 模式元数据必须恰好 1 页（chunked 分段为设计内降级，不算失败，
    // 但在 note 里标明——分段断点可能落在轮次中间，用户应知情）
    verdict.longpdf_pages_ok = longPdfs.every((x) => !x.mode || x.mode !== "single" || x.pages === 1);
    const chunked = longPdfs.filter((x) => x.mode === "chunked");
    if (P.orientation === "landscape" && pr.pdfs.length) {
      // 无 PDF 产物（formats 不含 pdf）时没有可验对象，跳过而不是 TypeError
      const pym = "import sys, pymupdf; d = pymupdf.open(sys.argv[1]); r = d[0].rect; print('1' if r.width > r.height else '0')";
      const w = await new Promise((resolve) => execFile("python", ["-c", pym, pr.pdfs[0]],
        { windowsHide: true, timeout: 60000, env: PY_ENV }, (e, so) => resolve((so || "").trim())));
      verdict.landscape_ok = w === "1";
    }
    // 排版确定性质检（layout-check.py：DOM 断言 + 栅格分析 + HTML↔PDF 交叉核对，无 agent）
    let lc = null;
    const skillDir = st.cfg?.skillDir || cfg.skillDir;
    try {
      if (!skillDir) throw new Error("状态里没有 skillDir");
      const out = await new Promise((resolve, reject) => {
        execFile("python", [path.join(skillDir, "layout-check.py"), st.folder],
          { windowsHide: true, timeout: 300000, maxBuffer: 64 * 1024 * 1024, env: PY_ENV },
          (err, stdout, stderr) => {
            // 有 fail 时 layout-check 以退出码 1 结束——stdout 里的 JSON 照常解析，
            // 不能当运行失败丢掉（否则 fails 明细丢失，只剩 Command failed）
            const text = String(stdout || "").trim();
            if (text.startsWith("{")) resolve(text);
            else reject(new Error(String(stderr || err?.message || "无输出").slice(-500)));
          });
      });
      lc = JSON.parse(out.slice(out.indexOf("{")));
    } catch (e) {
      lc = { fails: ["layout-check 运行失败: " + e.message], warns: [], checks: {} };
    }
    verdict.layout_ok = !(lc.fails || []).length;
    const pass = Object.values(verdict).every(Boolean);
    const lpNote = chunked.length
      ? "；长页 PDF " + chunked.map((x) => path.basename(x.file) + " " + x.pages + " 段").join("、") +
        "（内容超单页规格上限 18900px 已自动分段，断点可能落在轮次中间）" : "";
    return { status: pass ? "pass" : "fail", checks, verdict, layoutCheck: lc, products: pr, folder: st.folder,
             turnsFiltered: filtered ? st.filterKeep.length + "/" + (st.turns?.length || "?") + " 轮（spec: " + (st.turnsSpec || "?") + "）" : null,
             note: (pass ? "脚本质检通过（含 layout-check 排版断言：DOM 几何/栅格空洞/轮次与行号交叉核对）"
                         : "存在未过项：检查 verdict 与 layoutCheck.fails，或重跑对应相位") + lpNote };
  }

  throw new Error("未知相位: " + phase + "（open | extract | filter | render | verify；plan 为兜底）");
}
