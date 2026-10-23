/* export-tools.js v4 — 导出 HTML 内嵌工具（由 export-driver.mjs 在提取时注入到 body 结束标签之前）
 *
 * 功能：每轮上方的"第N轮"复选签（文档流内联）+ 工具条，按勾选范围生成 PNG 长图 /
 * 打印 A4 PDF（🖨 按钮走 window.print()，沿用导出的分页规则）。
 * 纯原生、无依赖。PNG 渲染走 SVG foreignObject → canvas：Chromium 原生渲染，oklch / color-mix
 * 等现代 CSS 均支持（html2canvas 解析不了这些函数，故弃用）。foreignObject 内不加载任何
 * 外部资源——提取时已把同源图片转 dataURL，因此入图完整；@font-face 远程字体回退为
 * 系统字体（正文与代码用系统字体栈，影响很小）。
 *
 * v4 变更：移除客户端长页 PDF 按钮。v3 试过"canvas → JPEG → 手写 PDF 封装"直出下载，
 * 但那是光栅版（无文本层、不可选中搜索），已否决；带文本层的固定尺寸长页 PDF 只有
 * 无头打印管线能给（render.py --longpdf 走 --print-to-pdf，@page 定高在无头路径被完整
 * 尊重；带 UI 的打印对话框则受纸张下拉覆盖，Chromium issue 41010929）——页面内不再
 * 提供长页 PDF 出口，需要长页 PDF 由 agent 跑管线产出 <名>-long.pdf。
 *
 * 注意：本文件的注释与字符串里不得出现 script/body/html 的闭合标签字面量——本脚本会被
 * 整体注入产物 HTML，多余的闭合标签字面量既会截断注入，也会抢先命中任何以"第一个闭合
 * 标签"做锚点的下游工具（layout-check 注入断言等）。需要提及这类标签时一律用文字表述。
 *
 * v2 关键变更（漂移修复）：复选签不再用"覆盖层 + getBoundingClientRect 快照"定位——
 * 那套架构在定时器/resize 窗口之外的布局变化（懒图解码、视口变宽）下必然漂移。
 * 现在复选签是轮次根的前一个兄弟节点（正常文档流），天然随内容移动，零定位代码。
 * 无头渲染（render.py 长图/逐页）的 UI 隐藏由 render.py 的 ._render.html 渲染副本
 * 注入 CSS 实现——headless=new 的 navigator.webdriver 是 false，不能当无头判据。
 */
(() => {
  "use strict";
  if (window.__ztools) return;
  const LIGHT = document.documentElement.classList.contains("theme-zai-light");

  // ---- 1. 依 ZTURN 注释定位轮次根（标记紧贴轮次根之前插入）----
  const findTurns = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT, null);
    const list = [];
    let c;
    while ((c = walker.nextNode())) {
      const m = /^ZTURN:(\d+):s$/.exec(c.nodeValue || "");
      if (!m) continue;
      let el = c.nextElementSibling;
      if (!el) { el = c.nextSibling; while (el && el.nodeType !== 1) el = el.nextSibling; }
      if (el) { el.setAttribute("data-zturn-i", m[1]); list.push({ i: +m[1], root: el }); }
    }
    list.sort((a, b) => a.i - b.i);
    return list;
  };
  const turns = findTurns();
  if (!turns.length) return; // 无标记（旧版产物）不启用

  // ---- 2. 样式 ----
  const st = document.createElement("style");
  st.textContent =
    ".zturn-chip{display:inline-flex;align-items:center;gap:6px;margin:6px 0 2px;" +
    "padding:2px 12px;border-radius:999px;font-size:12px;line-height:18px;cursor:pointer;user-select:none;" +
    "background:" + (LIGHT ? "rgba(255,255,255,.88)" : "rgba(18,18,18,.78)") + ";" +
    "color:" + (LIGHT ? "#333" : "#eee") + ";" +
    "border:1px solid " + (LIGHT ? "#c2c2c2" : "#555") + ";opacity:.85;transition:opacity .15s;" +
    "font-family:system-ui,sans-serif;}" +
    ".zturn-chip:hover,.zturn-chip.on{opacity:1;}" +
    ".zturn-chip input{margin:0;cursor:pointer;}" +
    "#zturn-bar{position:fixed;top:52px;right:10px;z-index:2147483001;display:flex;gap:6px;align-items:center;" +
    "padding:8px 10px;border-radius:10px;font-size:13px;font-family:system-ui,sans-serif;" +
    "background:" + (LIGHT ? "rgba(255,255,255,.94)" : "rgba(18,18,18,.92)") + ";" +
    "color:" + (LIGHT ? "#333" : "#eee") + ";" +
    "border:1px solid " + (LIGHT ? "#ccc" : "#555") + ";box-shadow:0 2px 10px rgba(0,0,0,.25);}" +
    "#zturn-bar button{padding:3px 10px;border-radius:6px;font-size:12px;cursor:pointer;" +
    "background:" + (LIGHT ? "#fff" : "#2a2a2a") + ";color:" + (LIGHT ? "#333" : "#eee") + ";" +
    "border:1px solid " + (LIGHT ? "#bbb" : "#555") + ";}" +
    "#zturn-bar button:hover{border-color:#4f8ef7;color:#4f8ef7;}" +
    "#zturn-bar .cnt{min-width:70px;text-align:center;}" +
    ".zturn-dim{opacity:.35;}" +
    // 测量/PNG 窗口把复选签从文档流中拿掉（display:none 不占高度，量出的就是净内容）
    "body.ztools-measure .zturn-chip{display:none!important;}" +
    "@media print{.zturn-chip,#zturn-bar{display:none!important;}.ztools-off{display:none!important;}}";
  document.head.appendChild(st);

  // ---- 3. 状态与持久化 ----
  // localStorage 键掺会话指纹：file:// 下所有本地文件同源，仅按文件名做键时
  // 两个不同会话的同名导出（如手动管线的 conversation-export.html）会互相串选择
  const fp = (() => {
    const s = (document.title || "") + "|" + turns.length + "|" +
      ((turns[0] && turns[0].root.textContent) || "").replace(/\s+/g, "").slice(0, 160);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  })();
  const lsKey = "zturnsel:" + (location.pathname.split("/").pop() || "x") + ":" + fp;
  const persist = () => { try { localStorage.setItem(lsKey, JSON.stringify([...sel])); } catch (e) {} };
  const sel = new Set(turns.map((t) => t.i));
  try {
    const saved = JSON.parse(localStorage.getItem(lsKey) || "null");
    if (Array.isArray(saved) && saved.length) {
      // 恢复的选择要与现存轮次取交集：文件可能被 filter 裁剪过，持久化里会含
      // 已删除的轮号（不取交则"已选 5/3 轮"计数失真）；交集为空回退默认全选
      const valid = new Set(turns.map((t) => t.i));
      const hit = saved.filter((i) => valid.has(i));
      if (hit.length) { sel.clear(); hit.forEach((i) => sel.add(i)); }
    }
  } catch (e) {}

  // ---- 4. UI：工具条 + 每轮上方的文档流复选签 ----
  const bar = document.createElement("div"); bar.id = "zturn-bar";
  const cnt = document.createElement("span"); cnt.className = "cnt";
  bar.appendChild(cnt);
  const mkBtn = (txt, fn, tip) => {
    const b = document.createElement("button");
    b.textContent = txt; b.title = tip || ""; b.onclick = fn;
    bar.appendChild(b); return b;
  };
  const setStatus = (t) => { cnt.textContent = t; };
  const refreshCnt = () => setStatus("已选 " + sel.size + "/" + turns.length + " 轮");

  const chips = [];
  for (const t of turns) {
    if (!t.root.parentElement) continue;
    const lb = document.createElement("label");
    lb.className = "zturn-chip";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = sel.has(t.i);
    const sp = document.createElement("span");
    sp.textContent = "第" + (t.i + 1) + "轮";
    lb.appendChild(cb); lb.appendChild(sp);
    lb.classList.toggle("on", cb.checked);
    if (!cb.checked) t.root.classList.add("zturn-dim");
    cb.onchange = () => {
      if (cb.checked) sel.add(t.i); else sel.delete(t.i);
      lb.classList.toggle("on", cb.checked);
      t.root.classList.toggle("zturn-dim", !cb.checked);
      refreshCnt(); persist();
    };
    // 复选签=轮次根的前一个兄弟节点：正常文档流，内容怎么动它就怎么动，永不漂移
    t.root.parentElement.insertBefore(lb, t.root);
    chips.push({ lb, t, cb });
  }
  mkBtn("全选", () => chips.forEach((c) => { c.cb.checked = true; sel.add(c.t.i); c.lb.classList.add("on"); c.t.root.classList.remove("zturn-dim"); refreshCnt(); persist(); }));
  mkBtn("清空", () => chips.forEach((c) => { c.cb.checked = false; sel.delete(c.t.i); c.lb.classList.remove("on"); c.t.root.classList.add("zturn-dim"); refreshCnt(); persist(); }));
  mkBtn("🖨 PDF", doPrint, "按选中轮次打印 / 另存为 PDF（沿用导出的 A4 分页规则）");
  mkBtn("🖼 PNG", () => doPNG(), "按选中轮次生成长图 PNG");

  document.body.appendChild(bar);
  refreshCnt();

  // ---- 5. PDF：未选轮次打 .ztools-off，@media print 隐藏后走原生打印 ----
  const applyOff = (on) => {
    for (const c of chips)
      if (!sel.has(c.t.i)) c.t.root.classList.toggle("ztools-off", on);
  };
  function doPrint() {
    if (!sel.size) { alert("请先勾选至少一轮"); return; }
    applyOff(true);
    const restore = () => { applyOff(false); window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    window.print(); // Chromium 的 print() 阻塞到打印预览关闭，返回后即可还原
    restore();
  }

  // ---- 6. PNG：测量窗口隐藏复选签 → 量净尺寸 → 克隆清理 → foreignObject SVG → canvas ----
  const baseName = () =>
    decodeURIComponent(location.pathname.split("/").pop() || "conversation").replace(/\.html?$/i, "");
  const selSuffix = () =>
    sel.size === turns.length ? "" : "-选" + [...sel].sort((a, b) => a - b).map((i) => i + 1).join("_").slice(0, 40);

  function doPNG(opts) {
    opts = opts || {};
    if (!sel.size) { alert("请先勾选至少一轮"); return Promise.resolve(null); }
    setStatus("PNG 生成中…");
    const tb = document.getElementById("themeToggleBtn");
    let svg = "", W = 0, H = 0;
    document.body.classList.add("ztools-measure"); // 复选签退出文档流：量到的是净内容高度
    bar.style.display = "none";
    if (tb) tb.style.display = "none";
    try {
      W = Math.ceil(document.documentElement.clientWidth);
      H = Math.ceil(document.documentElement.scrollHeight);
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script").forEach((n) => n.remove());
      clone.querySelectorAll(".zturn-chip,#zturn-bar,#themeToggleBtn").forEach((n) => n.remove());
      clone.querySelectorAll("[data-zturn-i]").forEach((n) => n.removeAttribute("data-zturn-i"));
      // 懒加载属性一并剥掉（旧产物提取时未处理；SVG 静态渲染无滚动视口，eager 更稳）
      clone.querySelectorAll("img[loading],img[fetchpriority],img[decoding]").forEach((n) => {
        n.removeAttribute("loading"); n.removeAttribute("fetchpriority"); n.removeAttribute("decoding");
      });
      const wc = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT, null);
      const dead = [];
      let cc;
      while ((cc = wc.nextNode())) dead.push(cc);
      dead.forEach((n) => n.remove());
      const cb2 = clone.querySelector("body");
      if (cb2) cb2.classList.remove("ztools-measure");
      const ser = new XMLSerializer().serializeToString(clone);
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
        '<foreignObject x="0" y="0" width="' + W + '" height="' + H + '">' + ser + "</foreignObject></svg>";
    } finally {
      document.body.classList.remove("ztools-measure");
      bar.style.display = "";
      if (tb) tb.style.display = "";
    }
    let scale = opts.scale != null ? opts.scale : 2;
    while (scale > 0.1 && (Math.round(W * scale) > 32767 || Math.round(H * scale) > 32767)) scale /= 2;
    if (Math.round(H * scale) > 65535 || Math.round(W * scale) > 65535)
      { setStatus("内容过长无法出 PNG，请减少所选轮次或用 PDF"); return Promise.resolve(null); }
    if (W * scale * H * scale > 220e6) scale = Math.min(scale, 1);

    return new Promise((resolve) => {
      const fail = (msg) => { setStatus(msg); resolve(null); };
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
          const cx = cv.getContext("2d");
          cx.drawImage(img, 0, 0, cv.width, cv.height);
          if (opts.fmt === "jpeg") {
            const url = cv.toDataURL("image/jpeg", opts.quality || 0.5);
            setStatus("画布渲染完成 " + cv.width + "x" + cv.height);
            resolve({ w: cv.width, h: cv.height, dataUrl: url });
            return;
          }
          cv.toBlob((blob) => {
            if (!blob) { fail("canvas 导出失败（内容过长？改用 PDF）"); return; }
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = (baseName() + selSuffix() + ".png").slice(0, 80);
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            setStatus("已下载 PNG（" + sel.size + "/" + turns.length + " 轮）");
            resolve({ w: cv.width, h: cv.height, bytes: blob.size });
          }, "image/png");
        } catch (e) { fail("PNG 失败：" + (e && e.message ? e.message : e)); }
      };
      img.onerror = () => fail("SVG 渲染失败（外部资源缺失？）");
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  // 调试/测试钩子：render({fmt:"jpeg",scale:.35}) 返回小图 dataURL
  window.__ztools = {
    version: 4,
    turns: turns.length,
    selected: () => [...sel].sort((a, b) => a - b),
    render: (o) => doPNG(o),
    print: doPrint,
    chips,
    lsKey,
  };
})();
