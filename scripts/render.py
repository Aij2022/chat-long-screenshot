#!/usr/bin/env python3
"""render.py — 把提取出的独立对话 HTML 渲染成网页级还原的 PDF + 长图。

用法:
    python render.py conversation-export.html --out-dir ./out [--width 1280]

依赖: pymupdf、Pillow、numpy（pip install pymupdf pillow numpy）。
Edge 路径按需改 EDGE 常量。
页面方向由 HTML 内的 @page 规则决定（当前为 A4 portrait，margin 10mm 0 ——
左右边距 0 保住 794px 纸宽 ≥ 768px md 断点，深色背景铺满纸面）。

产出:
    out/conversation.pdf        PDF（深/浅主题随导出 HTML）
    out/conversation-long.png   长图（底部空白已裁剪、左右裁到内容 ±24px）
    out/conversation-long.pdf   长页 PDF（--longpdf：整场一张按内容定高的超长页）
    out/page-NN.png             PDF 逐页渲染（dpi=110），供视觉验收
    out/lp-NN.png               长页 PDF 逐页渲染（dpi=110），供视觉验收
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

# Windows 管道编码取区域设置（cp936 编不了 emoji）——会话名含 emoji 时产物路径里
# 的 emoji 会让 print 直接 UnicodeEncodeError。driver 侧已注入 PYTHONIOENCODING，
# 这里兜底手动执行场景（errors="replace" 保证任何环境下不崩）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
# 启动器进程只在异常时才长时间存活（正常几秒内退出），120s 足够判死；
# 120 + 180(产物等待) < driver runRender 的 330s execFile 超时，避免 python 被先杀
EDGE_TIMEOUT = 120

# 长页 PDF 单页高度上限（CSS px）。PDF 规格页尺寸上限 200 英寸 = 14400pt = 19200px
# （超出属未定义行为，Adobe Acrobat 直接拒开），留余量取 18900。内容更高时自动
# 转为"分段长页"：按上限高度自然分页（比 A4 稀 17 倍），断点可能落在轮次中间。
LONGPDF_MAX_H = 18900


def file_url(path: Path) -> str:
    return Path(path).resolve().as_uri()


def wait_for_file(p: Path, timeout: float = 180) -> bool:
    """等产物落盘并写完（尺寸连续两采样稳定）。Edge 154+ 实测：启动器进程先于
    渲染任务退出（真实打印在分离的浏览器进程里继续），"进程已退出"不再等于
    "产物已就绪"——打印产物必须轮询等待，立即检查会把迟到产物误判为失败。"""
    deadline = time.monotonic() + timeout
    last = -1
    while time.monotonic() < deadline:
        try:
            size = p.stat().st_size
        except OSError:
            size = -1
        if size > 0 and size == last:
            return True
        last = size
        time.sleep(0.3)
    return False


def run_edge(extra: list[str], wait_out: Path | None = None) -> None:
    """独立 user-data-dir：本机已有 Edge 实例时，无头进程会把任务移交给它然后
    静默退出（产物不生成、退出码还是 0），独立 profile 强制单进程完成任务。
    临时 profile 用后即删；超时杀整棵进程树（Windows 下 kill 只杀直接子进程）。

    Edge 154+ 启动器先于任务退出、真实打印由分离的浏览器进程继续：等产物
    （wait_out）必须在这个进程还活着、profile 还没删时做——否则渲染中途
    profile 被删，任务静默死亡，产物永不出现（本轮实测踩坑）。"""
    profile = tempfile.mkdtemp(prefix="edge-headless-")
    cmd = [EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
           "--hide-scrollbars", f"--user-data-dir={profile}"] + extra
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        _, err = proc.communicate(timeout=EDGE_TIMEOUT)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        try:
            proc.communicate(timeout=10)
        except Exception:
            proc.kill()
        raise RuntimeError(f"Edge 无头渲染超时（>{EDGE_TIMEOUT}s）: {extra}")
    ready = wait_for_file(wait_out) if wait_out is not None else True
    shutil.rmtree(profile, ignore_errors=True)  # 产物就绪（或明确失败）后才准删 profile
    if proc.returncode != 0:
        tail = (err or b"")[-800:].decode("utf-8", "replace")
        raise RuntimeError(f"Edge 退出码 {proc.returncode}: {tail}")
    if not ready:
        raise RuntimeError(f"Edge 产物等待超时（180s 未落盘）: {wait_out}")


def render_pdf(html: Path, out: Path, grayscale: bool = False) -> None:
    out = Path(out).resolve()  # Edge 不认相对路径
    out.parent.mkdir(parents=True, exist_ok=True)  # 输出目录不存在时 Edge 静默退出（码 0）
    src = inject_style(html, "html{filter:grayscale(1)!important}", "._gray") if grayscale else html
    try:
        out.unlink(missing_ok=True)  # 先删旧产物：等待逻辑会把陈旧文件误判为新产物
        run_edge([f"--print-to-pdf={out}", "--no-pdf-header-footer", file_url(src)], wait_out=out)
    finally:
        if src is not html:
            src.unlink(missing_ok=True)


def render_png(html: Path, out: Path, width: int, height: int) -> None:
    out = Path(out).resolve()  # Edge 不认相对路径
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)  # 先删旧产物（同 render_pdf 理由）
    run_edge([
        f"--window-size={width},{height}",
        "--virtual-time-budget=10000",
        f"--screenshot={out}",
        file_url(html),
    ], wait_out=out)


def page_bg_color(arr):
    """页面底色 = 截图底部行的最左/最右几列的众数色。

    body 有 14px 左右 padding，即使内容触底截断，底部行的最左/最右几列仍是
    页面底色——比"底部整行众数"更抗内容污染（内容恰好截断在纯色卡片上时，
    底部众数会变成卡片色，导致触底误判）。两侧众数不一致（全出血内容污染
    边缘）时退回底部整行众数。"""
    left = Counter(map(tuple, arr[-50:, :4].reshape(-1, 3))).most_common(1)[0][0]
    right = Counter(map(tuple, arr[-50:, -4:].reshape(-1, 3))).most_common(1)[0][0]
    if sum(abs(int(a) - int(b)) for a, b in zip(left, right)) > 30:  # int()：uint8 减法会回绕
        return Counter(map(tuple, arr[-50:].reshape(-1, 3))).most_common(1)[0][0]
    return left


def bottom_is_content(arr, bgc, threshold=16) -> bool:
    """底部 50 行是否存在与底色差异超阈值的像素（= 内容触底，窗口不够高）。
    阈值取 16：浅色主题白卡 #fff 与底 #f8f8f8 三通道差和仅 21，阈值 24 会漏检。"""
    import numpy as np
    d = np.abs(arr[-50:].astype(int) - np.array(bgc, dtype=int)).sum(axis=2)
    return bool((d > threshold).any())


def content_rows(arr, bgc, threshold=16):
    """内容行索引（与底色差异超阈值的行）及逐行差异。"""
    import numpy as np
    rowdiff = np.abs(arr.astype(int) - np.array(bgc, dtype=int)).sum(axis=2).max(axis=1)
    return np.where(rowdiff > threshold)[0], rowdiff


def crop_sides(png, bgc, pad=24):
    """按内容列边界裁掉左右过宽的空白，保留 pad px 边距。返回新宽度。"""
    from PIL import Image
    import numpy as np

    im = Image.open(png).convert("RGB")
    arr = np.asarray(im)
    colink = (np.abs(arr.astype(int) - np.array(bgc, dtype=int)).sum(axis=2) > 16).sum(axis=0)
    inked = np.where(colink > 2)[0]
    if not inked.size:
        return arr.shape[1]
    left = max(0, int(inked[0]) - pad)
    right = min(arr.shape[1], int(inked[-1]) + 1 + pad)
    im.crop((left, 0, right, arr.shape[0])).save(png)
    return right - left


def inject_style(html: Path, css: str, suffix: str) -> Path:
    """返回注入 <style> 的临时渲染副本（不改动原件）；无锚点时原样返回并警告。

    锚点取文档末尾的闭合标签（rfind 最后一次出现）——产物内嵌工具脚本的注释/
    对话正文/标签属性值都可能含 "</head>"/"</body>" 字面量，取第一个会被抢先
    命中（踩坑清单"注入锚点被源码注释抢命中"）。序列化后真正的 </body> 一定是
    最后一次出现；style 注在文档末尾，层叠顺序只靠后不靠前，效果不变。"""
    text = html.read_text(encoding="utf-8")
    matches = list(re.finditer(r"</body>(\s*</html>)", text, re.I))
    if matches:
        i = matches[-1].start()  # 取末次匹配：属性值里的字面 "</body></html>" 排在真闭合之前
    else:
        low = text.lower()
        i = max(low.rfind("</body>"), low.rfind("</html>"))
    if i == -1:
        print(f"  警告: HTML 无注入锚点，{suffix} 副本未生成", file=sys.stderr)
        return html
    tmp = html.with_name(html.stem + suffix + ".html")
    tmp.write_text(text[:i] + f"<style>{css}</style>" + text[i:], encoding="utf-8")
    return tmp


def prep_render_copy(html: Path) -> Path:
    """长图用渲染副本：隐藏只属于交互式 HTML 的元素（主题切换按钮、轮次选择工具）。
    内嵌工具的浮签/工具条走 screen 媒体（@media print 藏不住），无头截图会把
    它们拍进长图，必须在渲染副本里显式隐藏。"""
    text = html.read_text(encoding="utf-8")
    # 检测用完整标记：对话正文可能转义地提到这些元素名（聊天内容就是本工具）
    if ("themeToggleBtn" not in text and "zturn-bar" not in text
            and "<script data-ztools>" not in text):
        return html
    return inject_style(html,
                        "#themeToggleBtn,.zturn-chip,#zturn-bar,#zturn-layer{display:none!important}",
                        "._render")


def pdf_page_bg(page):
    """PDF 页底色 = 页面上下边距条带的众数色（@page 上下边距 10mm 由画布背景
    填充，主题无关；60dpi 下 10mm ≈ 23.6px，取 20px 条带在边距区内）。
    前提：@page 上下边距 ≥ 9mm——条带落进内容区时底色估计可能失真（随附
    模板为 10mm 0，安全；页首尾整宽近均匀块 + 无文本末页有被误判的理论风险）。"""
    from PIL import Image
    import numpy as np

    pix = page.get_pixmap(dpi=60)
    arr = np.asarray(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
    strip = np.concatenate([arr[:20], arr[-20:]]).reshape(-1, 3)
    return Counter(map(tuple, strip)).most_common(1)[0][0], arr


def page_is_blank(page) -> bool:
    """末页是否纯背景：无文本且无墨迹（底色动态取自页面边距区，深浅主题通用；
    墨迹检测忽略最外 2px 边框——缩放产生的边缘亚像素混合不是内容）。"""
    import numpy as np

    if page.get_text().strip():
        return False
    bg, arr = pdf_page_bg(page)
    inner = arr[2:-2, 2:-2]
    ink = (np.abs(inner.astype(int) - np.array(bg, dtype=int)).sum(axis=2) > 30).sum(axis=1)
    return not bool(np.where(ink > 3)[0].size)


def save_doc(doc, out: Path) -> None:
    """pymupdf 文档落盘（临时文件 + 原子替换，避免半写产物）。"""
    tmp = out.with_suffix(".tmp.pdf")
    doc.save(str(tmp), garbage=3)
    doc.close()
    tmp.replace(out)


def crop_pdf_tail(doc, page, pad_css: int = 30):
    """把页面底部的纯背景区裁掉（cropbox 收到最后墨迹行 + pad_css）。

    长页 PDF 的 @page 高度是估算值（≥ 真实内容高），页尾必有一段底色空白；
    与长图不同 PDF 页无法重截图，用 CropBox 裁——文本层原样保留、零重编码。
    返回裁后页高（CSS px）；无需裁（内容贴底）或测不出墨迹时返回 None。"""
    import pymupdf

    bg, arr = pdf_page_bg(page)
    arr = arr[2:-2, 2:-2]  # 剔四边 2px：打印管线会在页右缘/底缘画 1px 滚动条与背景
    # 残迹（深灰、贯穿整页/整行），不剔则每行都"有墨"、页尾永远裁不掉（与
    # page_is_blank 忽略外圈 2px 同理；实测右缘 diff 291、底缘同样命中阈值 16）
    idx, _ = content_rows(arr, bg)
    if not idx.size:
        return None
    last_css = idx[-1] * 96 / 60  # pdf_page_bg 的 pixmap 固定 dpi=60
    m = page.mediabox
    max_h_css = m.height / 0.75  # pt → CSS px（96px = 72pt）
    new_h_css = min(max_h_css, last_css + pad_css)
    if new_h_css >= max_h_css - 2:
        return None
    # set_cropbox 用 pymupdf 俯视坐标（y 从页顶往下，实测 200x200 黑块页验证）；
    # 右缘同步裁 2pt 把滚动条残迹一并去掉（body padding ≥8px，内容不会贴边）
    page.set_cropbox(pymupdf.Rect(m.x0, m.y0, m.x1 - 2, m.y0 + new_h_css * 0.75))
    return new_h_css


def render_long_pdf(html: Path, out: Path, page_w_css: float, est_h: int,
                    grayscale: bool = False) -> dict:
    """长页 PDF：@page 按内容总高定制单页尺寸，整场对话一张超长页。

    est_h 来自 A4 PDF 页数估算（≥ 真实内容高）。流程：
    - 渲染后恰 1 页 → 用 CropBox 裁掉页尾估算余量（crop_pdf_tail）→ single；
    - 多页 → 内容比本档高：按观测页数收敛加高（pages×h 必 ≥ 真实高度）重试；
    - 加高到 LONGPDF_MAX_H 仍多页 → 内容超单页规格上限，当前渲染即最终
      "分段长页"（末页裁尾、删末尾空白页）→ chunked。
    打印走 print 媒体，内嵌工具 UI（复选签/工具条/主题按钮）由产物自带的
    @media print 规则隐藏，无需渲染副本处理；@page 覆写规则注在文档末尾，
    层叠顺序天然压过 head 里的 A4/横版规则。"""
    import pymupdf

    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    gray = "html{filter:grayscale(1)!important}" if grayscale else ""
    h = min(max(7600, est_h), LONGPDF_MAX_H)
    for _ in range(4):
        src = inject_style(html, f"@page{{size:{page_w_css}px {h}px;margin:0;}}" + gray, "._longpdf")
        try:
            if src is html:
                raise RuntimeError("HTML 无注入锚点，无法覆写 @page——长页 PDF 无法生成")
            out.unlink(missing_ok=True)  # 先删旧产物（同 render_pdf 理由）
            run_edge([f"--print-to-pdf={out}", "--no-pdf-header-footer", file_url(src)], wait_out=out)
        finally:
            if src is not html:
                src.unlink(missing_ok=True)
        doc = pymupdf.open(out)
        pages = len(doc)
        if pages == 1:
            new_h = crop_pdf_tail(doc, doc[0])
            meta = {"mode": "single", "pages": 1, "widthCss": round(page_w_css),
                    "heightCss": round(new_h if new_h else h)}
            save_doc(doc, out)
            return meta
        if h >= LONGPDF_MAX_H:  # 到顶仍多页 = 内容超单页上限：当前渲染即分段长页
            removed = 0
            while pages > 1 and page_is_blank(doc[pages - 1]):
                doc.delete_page(pages - 1)
                pages -= 1
                removed += 1
            new_h = crop_pdf_tail(doc, doc[pages - 1])
            for pi in range(pages - 1):  # 非末段：右缘滚动条残迹一并裁掉（末段 crop_pdf_tail 已带）
                m = doc[pi].mediabox
                doc[pi].set_cropbox(pymupdf.Rect(m.x0, m.y0, m.x1 - 2, m.y1))
            meta = {"mode": "chunked", "pages": pages, "widthCss": round(page_w_css),
                    "heightCss": round(new_h if new_h else h)}
            save_doc(doc, out)
            print(f"      长页 PDF 内容超单页上限 {LONGPDF_MAX_H}px，已自动分段为 {pages} 页"
                  + ("（已删除末尾空白页）" if removed else ""))
            return meta
        # 观测收敛：obs 页 × 页高 h ≥ 真实内容高，×1.05 后下轮必单页（若 ≤ 上限）
        h = min(int(pages * h * 1.05) + 400, LONGPDF_MAX_H)
    raise RuntimeError("长页 PDF 多次加高仍非单页（内容高度异常）——请改用 A4 PDF 或缩短会话")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html", help="提取出的独立 HTML")
    ap.add_argument("--out-dir", default="./out")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--grayscale", action="store_true", help="PDF 渲染为灰度（滤镜注入，保留文本层；长图不受影响）")
    ap.add_argument("--no-crop-sides", action="store_true", help="长图保留全宽，不左右裁边")
    ap.add_argument("--longpdf", action="store_true",
                    help="额外出长页 PDF（整场一张按内容定高的超长页；超上限自动分段）")
    ap.add_argument("--skip-longpng", action="store_true",
                    help="跳过长图渲染（formats 不含长图时省时；不影响 PDF 与长页 PDF）")
    args = ap.parse_args()

    html = Path(args.html)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf = out_dir / "conversation.pdf"
    png = out_dir / "conversation-long.png"

    print(f"[1/4] PDF: {pdf}")
    for old in out_dir.glob("page-*.png"):  # 先清理上一轮残留：中途失败也不会留下新旧混合的页图
        old.unlink()
    render_pdf(html, pdf, grayscale=args.grayscale)

    import pymupdf
    doc = pymupdf.open(pdf)
    n_pages = len(doc)

    # 删除尾部空白页（内容在页边界处恰好收尾时会多出一页纯背景页）
    removed = 0
    while n_pages > 1 and page_is_blank(doc[n_pages - 1]):
        doc.delete_page(n_pages - 1)
        n_pages -= 1
        removed += 1
    if removed:
        tmp = pdf.with_suffix(".tmp.pdf")
        doc.save(str(tmp), garbage=3)
        doc.close()
        tmp.replace(pdf)
        doc = pymupdf.open(pdf)
    print(f"      PDF 共 {n_pages} 页" + (f"（已删除 {removed} 页尾部空白页）" if removed else ""))

    print("[2/4] 长图（窗口高度按 PDF 页数估算，自动加高直到容纳全部内容）")
    from PIL import Image
    import numpy as np

    # A4 portrait 内容高约 1123px/页；按页数估算初始窗口（15% 余量），杜绝长图截断。
    # 无头 --screenshot 实测可靠上限约 80000px（更高会挂起；Pillow >178M 像素直接拒绝）
    MAX_LONG_H = 80000
    render_src = prep_render_copy(html)
    try:
        if args.skip_longpng:
            print("      跳过（--skip-longpng）")
            arr = None
        else:
            est = int(n_pages * 1123 * 1.15) + 400
            height = max(7600, min(est, MAX_LONG_H))
            if est > MAX_LONG_H:
                print(f"  警告: 估算内容高度 {est}px 超出无头截图可靠上限 {MAX_LONG_H}px（约 65 页以上）",
                      file=sys.stderr)
            for _ in range(4):
                render_png(render_src, png, args.width, height)
                arr = np.asarray(Image.open(png).convert("RGB"))
                bgc = page_bg_color(arr)
                if not bottom_is_content(arr, bgc):
                    break
                if height >= MAX_LONG_H:
                    raise RuntimeError(
                        f"内容高度超出长图上限 {MAX_LONG_H}px（PDF {n_pages} 页）。"
                        "长图无法生成（PDF 不受影响）；如需长图请缩短会话或分批导出。")
                height = min(int(height * 1.5), MAX_LONG_H)  # 内容触底 = 窗口不够高，加高重试
            else:
                raise RuntimeError("多次加高后内容仍触底，长图有截断风险，已中止（PDF 不受影响）")
            idx, _ = content_rows(arr, bgc)
            if idx.size == 0:
                raise RuntimeError("长图整幅无内容（底色检测失败或 HTML 渲染异常），已中止")
            last = idx[-1] + 1
            Image.open(png).crop((0, 0, arr.shape[1], min(last + 30, arr.shape[0]))).save(png)
            if args.no_crop_sides:
                w = arr.shape[1]  # 保留全宽
            else:
                w = crop_sides(png, bgc)
            print(f"      {png}  {w}x{min(last + 30, arr.shape[0])}")
    finally:
        if render_src is not html:
            render_src.unlink(missing_ok=True)  # 渲染副本用后即删

    # 长页 PDF：单页定高（内容 ≤ 规格上限）或分段长页。宽/高估算都以 A4 PDF 实际
    # 页面尺寸为准——portrait 794 / landscape 1123 随 @page 自动跟随（含 zparams 横版）
    lp_meta = None
    lp_out = out_dir / "conversation-long.pdf"
    if args.longpdf:
        print("[3/4] 长页 PDF（@page 按内容总高定制单页）")
        page_w_css = doc[0].rect.width / 0.75
        page_h_css = doc[0].rect.height / 0.75
        est_h = int(n_pages * max(page_h_css - 76, page_h_css * 0.85) * 1.15) + 400
        lp_meta = render_long_pdf(html, lp_out, page_w_css, est_h, grayscale=args.grayscale)
        print(f"      {lp_out}  {lp_meta['widthCss']}x{lp_meta['heightCss']}px"
              f"（{lp_meta['mode']}，{lp_meta['pages']} 页）")
        ldoc = pymupdf.open(lp_out)  # 验收用逐页渲染
        for i, pg in enumerate(ldoc):
            pg.get_pixmap(dpi=110).save(out_dir / f"lp-{i + 1:02d}.png")
        ldoc.close()
    else:
        print("[3/4] 长页 PDF：跳过（未指定 --longpdf）")

    print("[4/4] PDF 逐页渲染（验收用）")
    for old in out_dir.glob("page-*.png"):  # 清理上一轮残留，避免验收读到陈旧页图
        old.unlink()
    for i, page in enumerate(doc):
        page.get_pixmap(dpi=110).save(out_dir / f"page-{i + 1:02d}.png")
    doc.close()

    print("完成。质检走 layout-check.py 确定性断言（driver verify 相位自动跑）；"
          "人工/子代理目检仅为 warns 项的可选兜底。")
    if lp_meta is not None:
        # 末行结构化结果：driver render 相位从 render.py 末行 stdout 解析归档元数据
        print("LONGPDF " + json.dumps(lp_meta, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
