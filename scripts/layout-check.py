#!/usr/bin/env python3
"""layout-check.py — 排版布局确定性质检（无 agent、无视觉模型）。

用法:
    python layout-check.py <产物文件夹>

文件夹布局（export-driver render 相位的归档结构）:
    <名>.html / <名>.light.html      独立导出 HTML（根目录，忽略 ._ 副本）
    <名>.pdf / <名>-dark.pdf         PDF
    <名>-long.pdf / -light-long.pdf  长页 PDF（单页定高或分段）
    <名>-long.png / -light-long.png  长图
    pages/page-NN.png                PDF 逐页 PNG
    lp-NN.png                        长页 PDF 逐页 PNG

三层检查（全部可重复、纯脚本）:
  A. DOM 几何断言 —— 往 HTML 副本注入断言脚本，Edge 无头 --dump-dom 回传
     document.title 里的 JSON：横向溢出/破图/固定层泄漏/输入坞/编辑铅笔/
     代码块两栏网格对齐/轮次叠压/折叠文本/裁剪文本。
  B. 栅格分析 —— numpy 直接算 PNG：内部背景空洞（破图吞卡的特征）、空白页、
     调色板（主题漂移）、长图顶部留白与左右贴边。
  C. HTML↔PDF 交叉核对 —— 每轮文本必须在 PDF 里找得到（整卡消失即失配），
     代码行号最长连续序列两边必须一致（行号栏丢失/堆叠即失配）。

输出: 单行 JSON {"fails":[...], "warns":[...], "checks":{...}}；有 fails 时退出码 1。
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from pathlib import Path

# Windows 管道编码取区域设置——fails/warns 里的产物文件名含 emoji 时
# json.dumps(ensure_ascii=False) 会 print 崩溃（driver 已注入 PYTHONIOENCODING，
# 这里兜底手动执行场景）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
EDGE_TIMEOUT = 90

# ---------- A. DOM 断言（Edge 无头 print-to-pdf 通道回传，见 REPORTER_JS 说明） ----------
ASSERT_JS = r"""
(async () => {
  const out = {};
  const vis = (el) => { const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getBoundingClientRect().height > 1; };
  try { await Promise.all([...document.images].map((i) => i.complete ? 0 : i.decode().catch(() => {}))); } catch (e) {}
  await new Promise((r) => setTimeout(r, 300));
  out.docH = document.documentElement.scrollHeight;
  out.overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  // 真溢出判定：可见（opacity>0）、不位于代码块子树（diffs-container/code[data-code]，
  // 代码横向滚动属应用自身设计）的元素越过视口右缘才算布局破损；透明滚动条 UI/代码卡
  // 内部的 w-max 行容器会推高 document.scrollWidth 但不是缺陷（实测把宽表格缺陷淹没）
  const off = [...document.querySelectorAll("body *")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.right > document.documentElement.clientWidth + 2 && x.r.width > 8)
    // checkVisibility({opacityProperty}) 计入祖先链透明度——滚动条 UI 挂在 opacity-0
    // 包装层下（子元素自身 computed opacity=1），必须按"有效不可见"排除
    .filter((x) => { const s = getComputedStyle(x.el);
      if (s.visibility === "hidden") return false;
      return x.el.checkVisibility ? x.el.checkVisibility({ opacityProperty: true })
        : parseFloat(s.opacity) > 0; })
    .filter((x) => !(x.el.closest && (x.el.closest("code[data-code]") || x.el.closest("diffs-container"))));
  out.overflowOffenders = off.length;
  out.overflowSample = off.slice(0, 3).map((x) => x.el.tagName + "." + String(x.el.className || "").slice(0, 40));
  out.turns = document.querySelectorAll("[data-v4-turn-unit]").length;
  out.brokenImgs = [...document.images].filter((i) => i.getAttribute("src") && i.naturalWidth === 0).length;
  out.composerVisible = [...document.querySelectorAll("[data-v4-composer-dock]")].filter(vis).length;
  out.editVisible = [...document.querySelectorAll("[data-testid^='v4-edit']")].filter(vis).length;
  out.fixedVisible = [...document.body.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    return s.position === "fixed" && s.display !== "none" && el.getBoundingClientRect().height > 1
      && el.id !== "zturn-bar" && !(el.closest && el.closest("#zturn-bar"));
  }).length;
  let cb = 0, bad = 0;
  for (const code of document.querySelectorAll("code[data-code]")) {
    const g = code.querySelector("[data-gutter]"), c = code.querySelector("[data-content]");
    if (!g || !c) continue;
    cb++;
    const gr = g.getBoundingClientRect(), cr = c.getBoundingClientRect();
    if (gr.width < 2 || cr.width < 2 || cr.left < gr.right - 2 ||
        Math.abs(gr.top - cr.top) > 4 ||
        Math.abs(gr.height - cr.height) > Math.max(8, gr.height * 0.05)) bad++;
  }
  out.codeBlocks = cb; out.codeGridBad = bad;
  const ts = [...document.querySelectorAll("[data-v4-turn-unit]")]
    .filter((el) => el.checkVisibility ? el.checkVisibility() : !!el.offsetParent);  // 跳过隐藏轮（rect 全 0 会误报叠压）
  let ov = 0;
  for (let k = 1; k < ts.length; k++) {
    const a = ts[k - 1].getBoundingClientRect(), b = ts[k].getBoundingClientRect();
    if (b.top < a.bottom - 4) ov++;
  }
  out.turnOverlap = ov;
  let zt = 0, clip = 0;
  const ztSamples = [];
  const shown = (el) => el.checkVisibility ? el.checkVisibility()
    : !!(el.offsetParent || getComputedStyle(el).position === "fixed");
  for (const el of document.querySelectorAll("p,li,td,th,pre,code,span")) {
    if (el.closest && el.closest(".sr-only")) continue;  // 无障碍隐藏文案（复制/赞等），有字无高是设计
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    if (!shown(el)) continue;  // 祖先 display:none 的隐藏子树（侧栏等）不算布局缺陷
    const r = el.getBoundingClientRect();
    if (r.height < 2) { zt++;
      if (ztSamples.length < 5) ztSamples.push(el.tagName + "." + String(el.className || "").slice(0, 36) + ":" + (el.textContent || "").trim().slice(0, 24)); }
    const s = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 8 && s.overflowX !== "visible") clip++;
  }
  out.zeroText = zt; out.zeroTextSample = ztSamples; out.clippedText = clip;
  // 内嵌工具存活检查：script 标签在而 __ztools 没起来 = 脚本语法/执行错误静默死亡
  // （离线补丁把 \n 写成真换行曾致工具条整体消失，见踩坑清单），warn 兜底
  out.hasZtoolsScript = !!document.querySelector("script[data-ztools]");
  out.ztoolsOk = !!window.__ztools;
  document.title = "LCRESULT" + JSON.stringify(out);
  window.__LCRESULT__ = JSON.stringify(out);
})();
"""

# Edge 154+ 实测：无头 --dump-dom 的 stdout 随启动器进程一起早亡（真正的渲染在
# 分离的浏览器进程里，stdout 不回传，dump 输出 0 字节），DOM 断言结果拿不到；
# PDF 文本层通道（pre 分行 hex → get_text）又实测偶发行序损坏。改走 PDF 元数据：
# Chromium 打印把 document.title 原样写进 PDF /Title（1000+ 字符实测无截断、
# 逐字节无损），断言脚本把 JSON 的 hex 挂到 title，pymupdf 读 metadata 还原。
REPORTER_JS = r"""
(async () => {
  for (let i = 0; i < 300; i++) {
    if (window.__LCRESULT__) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const bytes = new TextEncoder().encode(window.__LCRESULT__ || "{}");
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  document.title = "LCH" + hex;
})();
"""

try:
    from render import wait_for_file  # 与 render.py 同目录：同款"产物就绪"判定
except ImportError:  # 单独拷贝本文件使用时的兜底
    import time as _time

    def wait_for_file(p, timeout=180.0):
        deadline = _time.monotonic() + timeout
        last = -1
        while _time.monotonic() < deadline:
            try:
                size = p.stat().st_size
            except OSError:
                size = -1
            if size > 0 and size == last:
                return True
            last = size
            _time.sleep(0.3)
        return False


def edge_assert(url: str, out_pdf: Path) -> dict:
    """无头渲染并回传断言 JSON（PDF 元数据通道，见 REPORTER_JS 说明）。
    独立 user-data-dir 防止被已开 Edge 实例接管；产物就绪前不得删临时 profile
    （Edge 154+ 启动器早退、真实任务在分离进程里继续，profile 随删任务随死）。"""
    profile = Path(tempfile.mkdtemp(prefix="lc-edge-"))
    try:
        proc = subprocess.Popen(
            [EDGE, "--headless=new", "--disable-gpu", f"--user-data-dir={profile}",
             "--no-first-run", "--hide-scrollbars", "--virtual-time-budget=9000",
             f"--print-to-pdf={out_pdf}", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            proc.communicate(timeout=EDGE_TIMEOUT)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
            try:
                proc.communicate(timeout=10)
            except Exception:
                proc.kill()
            raise RuntimeError(f"Edge 无头渲染超时（>{EDGE_TIMEOUT}s）")
        if not wait_for_file(out_pdf):
            raise RuntimeError("断言 PDF 未生成（Edge 被接管或启动器早死后产物未落盘）")
        import pymupdf
        doc = pymupdf.open(out_pdf)
        title = doc.metadata.get("title") or ""
        doc.close()
        if not title.startswith("LCH"):
            raise RuntimeError("断言结果未回传（PDF Title 无 LCH 前缀）")
        return json.loads(bytes.fromhex(title[3:]).decode("utf-8"))
    finally:
        shutil.rmtree(profile, ignore_errors=True)

def inject_before_body_end(text: str, payload: str) -> str:
    """注入到真正的 body 结束标签前。锚点用 "</body></html>" 相邻对——产物内嵌的
    工具脚本注释/对话正文都可能含字面 "</body>"（本工具链聊的就是这些标记），
    取"第一个 </body>"会被抢先命中（实测断言脚本被插进注释文本、从未执行）。
    相邻对同样取【末次】匹配：属性值不转义尖括号，含字面 "</body></html>" 的
    data-* 属性会排在真闭合标签之前。"""
    matches = list(re.finditer(r"</body>(\s*</html>)", text, re.I))
    if matches:
        i = matches[-1].start()
        return text[:i] + payload + text[i:]
    i = text.lower().rfind("</body>")
    return text + payload if i == -1 else text[:i] + payload + text[i:]

def dom_checks(html: Path) -> dict:
    """注入断言脚本的无头检查。返回断言结果字典；异常时返回 {'err': ...}。"""
    text = html.read_text(encoding="utf-8")
    # 脚本在打印管线的绘制阶段之前执行（实测 getComputedStyle 时 @media print 尚未
    # 生效）——把副本里所有 print 媒体块改写成 all，让断言测到的就是 PDF 实际渲染的
    # 打印布局（宽表收窄、复选签隐藏等），否则测的是"794px 视口的屏幕布局"假溢出
    text = re.sub(r"@media\s+print\s*\{", "@media all{", text, flags=re.I)
    inject = ('<style>#zturn-bar,.zturn-chip,#themeToggleBtn{display:none!important}</style>'
              '<script>' + ASSERT_JS + '</script>'
              '<script>' + REPORTER_JS + '</script>')
    if "</body>" not in text.lower():
        return {"err": "no-body-anchor"}
    copy = html.with_name(html.stem + "._lc.html")
    out_pdf = html.with_name(html.stem + "._lc.pdf")
    try:
        copy.write_text(inject_before_body_end(text, inject), encoding="utf-8")
        out_pdf.unlink(missing_ok=True)
        return edge_assert(copy.resolve().as_uri(), out_pdf.resolve())
    except Exception as e:
        return {"err": str(e)[:140]}
    finally:
        copy.unlink(missing_ok=True)
        out_pdf.unlink(missing_ok=True)

def judge_dom(res: dict, fails: list, warns: list) -> None:
    if "err" in res:
        fails.append(f"DOM 断言未回传: {res['err']}")
        return
    if res.get("overflowOffenders", 0) > 0:
        fails.append(f"横向溢出 {res.get('overflowX', '?')}px（内容被裁/布局破）: "
                     + "; ".join(res.get("overflowSample", [])[:3]))
    if res.get("brokenImgs", 0) > 0:
        fails.append(f"破图 {res['brokenImgs']} 张（打印会吞掉整卡）")
    if res.get("fixedVisible", 0) > 0:
        fails.append(f"可见 fixed 元素 {res['fixedVisible']} 个（悬浮件泄漏）")
    if res.get("composerVisible", 0) > 0:
        fails.append("输入坞可见")
    if res.get("editVisible", 0) > 0:
        fails.append(f"编辑铅笔可见 {res['editVisible']} 个")
    if res.get("codeGridBad", 0) > 0:
        fails.append(f"代码块两栏网格破损 {res['codeGridBad']}/{res.get('codeBlocks', '?')}"
                     "（行号栏丢失或与代码上下堆叠）")
    if res.get("turnOverlap", 0) > 0:
        fails.append(f"轮次叠压 {res['turnOverlap']} 处（static 化失败）")
    if res.get("zeroText", 0) > 10:
        warns.append(f"折叠文本元素 {res['zeroText']} 个（有字无高）: "
                     + "; ".join(res.get("zeroTextSample", [])[:3]))
    if res.get("hasZtoolsScript") and not res.get("ztoolsOk"):
        warns.append("内嵌工具未初始化（__ztools 不存在）——工具条/复选签不会出现，"
                     "内嵌脚本语法或执行错误，提取内嵌脚本做 node --check")
    if res.get("clippedText", 0) > 0:
        warns.append(f"疑似横向裁剪文本 {res['clippedText']} 个")

# ---------- B. 栅格分析 ----------
def load_ink(png: Path):
    from PIL import Image
    import numpy as np
    im = Image.open(png).convert("RGB")
    arr = np.asarray(im).astype(int)
    # 底色：底部 40 行最左/最右 4 列众数（与 render.py 同思路，两侧不一致时退回整行）
    edge = np.concatenate([arr[-40:, :4].reshape(-1, 3), arr[-40:, -4:].reshape(-1, 3)])
    bg = np.array(Counter(map(tuple, edge)).most_common(1)[0][0], dtype=int)
    # 阈值 10：深色主题卡片 #161616 与页面底 #121212 三通道差和只有 12——
    # 阈值 16 会把卡片内部空白判成"背景"，在稀疏卡片区间凭空造出数百 px 的假空洞
    ink = np.abs(arr - bg).sum(axis=2) > 10
    return arr, ink

def row_profile(ink):
    """按"行墨迹像素占比>0.5%"定义内容行。逐行 any-ink 判据不可用：抗锯齿/阴影
    噪声会让 ~99.7% 的行都含墨点（实测 420px 空洞因此漏检），必须看占比。"""
    import numpy as np
    return ink.mean(axis=1) > 0.005

def row_holes(ink) -> tuple[int, int]:
    """内部背景行游程：返回 (最大游程, >120px 游程个数)。只统计首末内容行之间。"""
    import numpy as np
    rows = row_profile(ink)
    idx = np.where(rows)[0]
    if idx.size < 5:
        return 0, 0
    inside = rows[idx[0]:idx[-1] + 1]
    runs, run = [], 0
    for v in inside:
        if not v:
            run += 1
        elif run:
            runs.append(run)
            run = 0
    return (max(runs) if runs else 0), sum(1 for r in runs if r > 120)

def judge_png(png: Path, kind: str, fails: list, warns: list) -> dict:
    import numpy as np
    arr, ink = load_ink(png)
    h, w = arr.shape[:2]
    out = {"w": int(w), "h": int(h)}
    rows = row_profile(ink)
    ink_rows = int(rows.sum())
    out["inkRows"] = ink_rows
    if kind == "page":
        if ink_rows < 0.003 * h:
            fails.append(f"{png.name} 近乎空白页（内容行 {ink_rows}/{h}）")
    maxrun, big = row_holes(ink)
    out["holeMax"] = int(maxrun)
    out["holes>120"] = int(big)
    if maxrun > 220:
        fails.append(f"{png.name} 内部背景空洞 {maxrun}px（疑似整卡被打印管线吞掉）")
    elif maxrun > 120:
        warns.append(f"{png.name} 内部背景间隙 {maxrun}px（人工复核）")
    if kind == "long":
        import numpy as np
        first = int(np.where(rows)[0][0]) if rows.any() else -1
        out["firstInkRow"] = first
        if first > 60:
            warns.append(f"{png.name} 顶部空白 {first}px（裁剪异常？）")
        edge_ink = float(ink[:, :6].mean() + ink[:, -6:].mean())
        out["edgeInk"] = round(edge_ink, 4)
        if edge_ink > 0.005:
            warns.append(f"{png.name} 内容贴左右裁剪边（edgeInk={edge_ink:.3f}）")
        light = "light" in png.name
        lum = float(arr.mean())
        out["lum"] = round(lum, 1)
        if light:
            out["darkFrac"] = round(float(((arr < 30).all(axis=2)).mean()), 4)
            if lum <= 180:
                warns.append(f"{png.name} 浅色主题亮度偏低（{lum:.0f}）")
            if out["darkFrac"] > 0.40:
                fails.append(f"{png.name} 浅色主题暗区占比 {out['darkFrac']:.0%}（主题漂移？）")
            elif out["darkFrac"] > 0.20:
                warns.append(f"{png.name} 暗区占比 {out['darkFrac']:.0%}（代码块多属正常）")
        else:
            out["whiteFrac"] = round(float(((arr > 242).all(axis=2)).mean()), 4)
            if lum >= 80:
                fails.append(f"{png.name} 深色主题亮度偏高（{lum:.0f}，疑似变浅色）")
            if out["whiteFrac"] > 0.15:
                fails.append(f"{png.name} 白底占比 {out['whiteFrac']:.0%}（白卡泄漏）")
            elif out["whiteFrac"] > 0.05:
                warns.append(f"{png.name} 白色像素 {out['whiteFrac']:.0%}（贴图白底属正常）")
    return out

# ---------- C. HTML ↔ PDF 交叉核对 ----------
def turn_texts(html_src: str) -> list[tuple[int, str]]:
    out = []
    for m in re.finditer(r"<!--ZTURN:(\d+):s-->([\s\S]*?)<!--ZTURN:\1:e-->", html_src):
        seg = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", m.group(2))
        seg = re.sub(r"<[^>]+>", " ", seg)
        seg = unescape(seg)
        out.append((int(m.group(1)), re.sub(r"\s+", "", seg)))
    return out

def max_line_run(nums: list[int]) -> int:
    """最长连续整数游程。不要求从 1 起：PDF 文本提取可能把首行行号与代码合并，
    导致序列从 2 开始（旧实现把 2,3,4 计为 2， 造成"行号栏丢失"误报）。"""
    best = cur = 0
    prev = None
    for n in nums:
        cur = cur + 1 if (prev is not None and n == prev + 1) else 1
        best = max(best, cur)
        prev = n
    return best

def cross_check(html: Path, pdf: Path, fails: list) -> dict:
    import pymupdf
    src = html.read_text(encoding="utf-8")
    doc = pymupdf.open(pdf)
    text = "".join(pg.get_text() for pg in doc)
    pages = len(doc)
    norm = re.sub(r"\s+", "", text)
    out = {"pdfPages": pages}
    if text.count("\ufffd"):
        fails.append(f"{html.name}↔{pdf.name}: PDF 含 {text.count(chr(0xFFFD))} 个 U+FFFD")
    turns = turn_texts(src)
    missing = []
    for i, t in turns:
        if len(t) < 6:
            continue
        needles = [t[:12], t[len(t) // 2: len(t) // 2 + 12]] if len(t) >= 24 else [t]
        if not any(nd and nd in norm for nd in needles):
            missing.append(i + 1)
    out["turns"] = len(turns)
    out["turnMissing"] = missing
    if missing:
        fails.append(f"{html.name}: 第 {missing} 轮的文本在 {pdf.name} 中找不到（整卡丢失？）")
    h_nums = [int(x) for x in re.findall(r"data-line-number-content[^>]*>(\d+)<", src)]
    h_run = max_line_run(h_nums)
    p_nums = [int(s.strip()) for s in text.splitlines() if s.strip().isdigit()]
    p_run = max_line_run(p_nums)
    out["htmlLineRun"], out["pdfLineRun"] = h_run, p_run
    if h_run > 0 and p_run < h_run:
        fails.append(f"{html.name}: 代码行号最长序列 HTML={h_run} 但 PDF={p_run}（行号栏丢失/不可见）")
    return out

# ---------- 主流程 ----------
def html_theme_light(text: str) -> bool:
    """从 <html> 开标签判定导出主题。不能全文搜类名——站点 CSS 对深浅两个类都有
    定义、内嵌工具也引用类名，正文里出现 theme-zai-light 字样不代表本文件是浅色。"""
    m = re.search(r"<html[^>]*>", text[:16384], re.I)
    tag = m.group(0) if m else ""
    if "theme-zai-light" in tag:
        return True
    if "theme-zai-dark" in tag:
        return False
    return 'data-zcode-bootstrap-theme="light"' in tag


def pair_pdf_for(h: Path, text: str) -> Path:
    """按内容主题（而非文件名后缀）推配对 PDF：dark ↔ <名>-dark.pdf，light ↔ <名>.pdf。
    旧实现只看后缀，theme="light" 的主文件叫 <名>.html，会去找不存在的 <名>-dark.pdf，
    整个交叉核对被静默跳过。"""
    base = h.stem[:-len(".light")] if h.name.endswith(".light.html") else h.stem
    return h.with_name(base + ("-dark.pdf" if not html_theme_light(text) else ".pdf"))


def long_pdf_html_for(folder: Path, lp: Path) -> Path:
    """长页 PDF ↔ 导出 HTML 配对：<名>-long.pdf ↔ <名>.html（深色）、
    <名>-light-long.pdf ↔ <名>.light.html（浅色）。

    单主题导出（theme="light" 且产物不含 A4 PDF）时目录里只有一个 HTML 且就叫
    <名>.html（内容已是浅色），按名字找不到 <名>.light.html——此时回退到"按内容
    主题找同主题 HTML"，否则浅色长页 PDF 的交叉核对被静默跳过（浅色恰恰是最常被
    要求的长页 PDF 形态）。"""
    base = lp.name[:-len("-long.pdf")]
    light = base.endswith("-light")
    if light:
        base = base[:-len("-light")]
    cand = folder / (base + (".light.html" if light else ".html"))
    if cand.exists():
        return cand
    for h in sorted(p for p in folder.glob("*.html")
                    if not p.name.startswith(".") and "._" not in p.name):
        try:
            if html_theme_light(h.read_text(encoding="utf-8", errors="replace")) == light:
                return h
        except OSError:
            continue
    return cand


def main() -> int:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    fails: list[str] = []
    warns: list[str] = []
    checks: dict = {}
    htmls = sorted(p for p in folder.glob("*.html")
                   if not p.name.startswith(".") and "._" not in p.name)
    all_pdfs = sorted(folder.glob("*.pdf"))
    # 长页 PDF 与 A4 PDF 分开归类：交叉核对各自配对，A4 配对告警逻辑不被长页干扰
    long_pdfs = [p for p in all_pdfs if p.name.endswith("-long.pdf")]
    pdfs = [p for p in all_pdfs if not p.name.endswith("-long.pdf")]
    pngs = sorted(set(folder.glob("*-long.png")) | set(folder.glob("*-light-long.png")))
    lps = sorted(folder.glob("lp-*.png"))
    pages = sorted((folder / "pages").glob("page-*.png")) if (folder / "pages").is_dir() else []

    # DOM 断言逐文件一个无头实例，多文件并行（每次 Edge 启动 ~8-15s，并行省一半）
    dom_results: dict = {}
    if htmls:
        with ThreadPoolExecutor(max_workers=min(4, len(htmls))) as pool:
            futs = {pool.submit(dom_checks, h): h for h in htmls}
            for fut, h in futs.items():
                try:
                    dom_results[h] = fut.result()
                except Exception as e:  # Edge 缺失/超时等：降级为警告（栅格与交叉核对仍然兜底）
                    dom_results[h] = {"err": str(e)[:120]}
                    warns.append(f"DOM 断言未能运行（{h.name}）: {e}")
    for h in htmls:
        res = dom_results.get(h) or {"err": "no-result"}
        checks[f"dom:{h.name}"] = res
        judge_dom(res, fails, warns)
        # 交叉核对配对按内容主题：dark html ↔ <名>-dark.pdf；light html ↔ <名>.pdf
        try:
            pair = pair_pdf_for(h, h.read_text(encoding="utf-8"))
        except Exception as e:
            warns.append(f"主题判定失败（{h.name}）: {e}")
            pair = None
        if pair and pair.exists():
            try:
                checks[f"x:{h.name}"] = cross_check(h, pair, fails)
            except Exception as e:
                warns.append(f"交叉核对失败（{h.name}）: {e}")
        elif pair and pdfs and len(htmls) == 1:
            # 单主题导出且目录里确有 PDF 却配不上对——大概率产物命名错位，提示人工；
            # 默认组合主题只产白底 PDF（深色 HTML 无对应 PDF 属设计内），多文件时不告警
            warns.append(f"{h.name}: 未找到同主题 PDF（期望 {pair.name}），交叉核对跳过")
    for p in pngs:
        try:
            checks[f"png:{p.name}"] = judge_png(p, "long", fails, warns)
        except Exception as e:
            warns.append(f"栅格分析失败（{p.name}）: {e}")
    # 长页 PDF：与导出 HTML 做同款交叉核对（每轮文本必须在、行号序列两边一致），
    # 逐页 PNG（lp-*.png）按"页"做栅格分析（空白/内部空洞）
    for p in long_pdfs:
        h = long_pdf_html_for(folder, p)
        if not h.exists():
            warns.append(f"{p.name}: 找不到对应 {h.name}，交叉核对跳过")
            continue
        try:
            checks[f"lp:{p.name}"] = cross_check(h, p, fails)
        except Exception as e:
            warns.append(f"长页 PDF 交叉核对失败（{p.name}）: {e}")
    for i, p in enumerate(lps):
        try:
            checks[f"lpng:{p.name}"] = judge_png(p, "page", fails, warns)
        except Exception as e:
            warns.append(f"栅格分析失败（{p.name}）: {e}")
    for i, p in enumerate(pages):
        try:
            checks[f"page:{p.name}"] = judge_png(p, "page", fails, warns)
        except Exception as e:
            warns.append(f"栅格分析失败（{p.name}）: {e}")

    print(json.dumps({"fails": fails, "warns": warns, "checks": checks},
                     ensure_ascii=False, separators=(",", ":")))
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
