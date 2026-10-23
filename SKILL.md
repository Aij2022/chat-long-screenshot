---
name: chat-long-screenshot
description: 对话长截图 —— 给一个远程控制链接，打开页面后停下等用户在页面上选好对话并回复"开始"，然后直接输出网页还原 HTML + A4 PDF（默认参数，全程零询问、自动建文件夹）；也可手动分步、可选长页 PDF/长图与轮次筛选。把网页聊天/远程控制页面中的对话导出为与网页样式一致的 PDF/长页 PDF/HTML/长图。Use whenever the user wants to 对话长截图/导出/打印/转存聊天会话或对话记录（含"只导出第X条回复/最后几轮/某几轮"的部分导出）、远程页面打印只出列表或空白、或需要任何 SPA 聊天界面的网页级还原 PDF/长页 PDF/长截图 —— 即使用户只说"把这个对话导出成PDF/图片"或"来个对话长截图"也要用本技能。
---

# ZCode 远程对话导出（网页级还原 HTML / PDF）

把远程控制页面里正在显示的对话，导出成**与网页渲染样式一致**的网页还原 HTML（深色，浏览器可切浅色）
和 A4 竖版 PDF（白底打印友好）；长图（PNG/JPG）与**长页 PDF**（整场对话一张按内容定高的超长页，
传 `formats:["html","longpdf"]` 即出）为可选项。
流水线经多轮实测迭代；v2 修复（见踩坑清单"游离克隆"/"变量注入"两行）已过离线单测；2026-10-02 修复批次
（Python 子进程编码 / 注入锚点全局跟进 / 参数离线同步 / 主题配对等）已过纯函数自测与语法检查，
2026-10-09 批次（Edge 154 启动器早退→产物等待/profile 存活/DOM 断言改 metadata 通道；longpdf 长页 PDF；
宽表格打印裁切修复）已过离线合成验收 + 真实会话实战验收（5 轮 R 统计会话，verify pass、双 PDF 交叉核对全绿）；
2026-10-09 晚批次（内嵌工具 🧾 长页PDF 先后试过"@page+打印对话框"与"canvas→JPEG→手写 PDF 直出"
两案，均不满足要求——前者纸张下拉锁不住，后者是光栅无文本层；v4 移除页面内长页 PDF 出口，
固定尺寸标准长页 PDF（矢量+文本层）只由无头管线 `--longpdf` 提供；双产物整块升级后 layout-check
零回归）；
2026-10-09 深夜批次（修 driver→模板 DUAL 参数真值坑——"0" 恒真致单主题恒走双分支、整串校验必挂，
实测五连挂；driver 侧单主题传空串 + 模板侧 `=== "1"` 双保险；传输改"单发一次 evaluate 取整串 +
分块兜底（整串不符但解码验证通过放行并落盘证据）+ 提取撞页面重载自动重试"；已装 skill 本体已回填，
工作副本与本体同步），
2026-10-20 批次（适配 app 3.16.2：①**新增登录门**——裸 sid 链接不再直接进控制页，须选平台 OAuth
且与电脑端同一账号，ensureUsable 已加 loginGate 检测与明确报错；②渐隐 mask 从"message-layer 行内
固定 550px"改为**滚动驱动动态 maskImage**（目标元素不限于 message-layer）+ Tailwind `[mask-image:…]`
工具类，Node 侧修复加宽为全元素剥内联 mask + `[class*=mask-image]` 中和；③data-v4-* 全部锚点经
3.16.2 前端 bundle 静态比对确认存活，无 v5 改名；④**等稳定/滚动穿透移出主 evaluate**（PREP_SNIPPET
driver 逐发驱动，解 32s 桥上限，见坑清单）；⑤会话列表锚点换 `data-testid^="task-item-"`（旧
"打开任务"aria-label 已删），plan 相位改 tid 直点；⑥真实会话全量验收 pass：16 轮/23 代码块/2.5MB
双主题 HTML + 15 页 A4 PDF，layout-check 0 fails 0 warns），
2026-10-23 批次（3.16.3 复验 + **目标钉扎自愈**：桌面端切走会话远程页即整页刷新，导出不再要求
用户停留在目标对话——extract 开跑时把目标钉成 tid（plan 锁定的 st.tid，或"当前"从侧栏
bg-selected 条目 + 主区 `[data-session-id]` 现读钉入 st.pinnedTid），每次提取尝试前核对活动会话、
不符就自动重开；就绪判据=活动 tid 相等而非 turns>0（时序坑见坑清单）；PAGE_CLICK 改 IIFE 占位符
注入（桥不调用函数值表达式，见坑清单）；缓冲丢失改可重试。真实自愈演练 pass：页面停在别的会话
时 extract 自动重开目标并导出，内容核验零串扰，9s 完成），
**换站点首次使用时先跑一轮完整验收**。

## 核心原则：一次现场提取，全部离线迭代

远程会话随时可能死掉（Relay 单设备限制会被 KICKED）。所以：

1. **在活页面上只做一次提取**（克隆 DOM + 内联全部样式 + 打包成独立 HTML，一个 evaluate 内完成）；
2. 提取**在克隆体内完成所有改动**（打标、隐藏、拍平都在 clone 上），活页面零改动、零恢复成本；
3. 之后所有打磨（PDF 分页、长图裁剪、样式补丁）都在**独立 HTML 文件**上离线进行，与远程会话无关。

不要把"提取"拆成多次活页面往返——这是本流程曾经翻车的根源。

## 前置条件与坑

- **远程链接 + 同账号登录态＝电脑控制权，妥善存放**：链接（含 sid+hash）本身即等价于控制这台机器
  的凭据；app 3.16.2 起远程页**另加登录门**——浏览器还须登录与电脑端**同一平台同一账号**才能进入
  控制页（见坑清单"登录门"）。约定存放于用户私有目录 `%USERPROFILE%\.zcode\secrets\zcode-remote-session.url`
  （首条非注释行），export-driver 在未显式传 `url` 时自动读取——**不要**把链接粘贴到聊天（聊天记录/
  对话导出产物会留存它）、不要写进 skill 包/git/任何产物。若疑似泄露：在 zcode 客户端重新生成远程链接
  （旧 sid 作废）并更新该文件首行。
- **Relay 单设备**：同一时间只允许一个远程控制端，重复加载页面/新标签连同一 sid 会互踢（Relay 返回 KICKED）。
  被踢后点页面上的"重新连接"按钮即可免扫码恢复；不要在提取中途 reload 页面。
- **对话轮次是 `absolute + translateY(Npx)` 虚拟定位**（每个轮次 div 类名含 `absolute`，行内 style 带
  translateY）。直接克隆/打印必然散架，必须转成文档流（见提取脚本）。
- **`dark:` 工具类包在 `@media (prefers-color-scheme: dark)` 里**，而 Edge 无头默认浅色偏好。
  只依赖 `.dark` 类的变量（`.theme-zai-dark`）没问题，但若导出后变浅色，检查这里。
- **浏览器内置 fullPage 截图不可用**：对解锁后的 100vh 应用壳，IAB 的 fullPage 会把同一帧重复拼接。
  长图一律走 Edge 无头 `--screenshot` 大窗口 + 底部裁剪。
- **node_repl 桥对单个命令限 32s**：app 3.16.2 起提取已拆相——等稳定轮询与懒加载滚动穿透改为
  driver 逐发小 evaluate（PREP_SNIPPET，每发亚秒级），主 evaluate 只做纯计算（克隆+CSSOM+编码），
  32s 预算全部留给计算；16 轮/23 代码块/2.5MB 产物实测畅通。超大计算仍可能顶破（报
  "browser 命令 playwright 超时（32000ms）"），超时后的处置见踩坑清单"node_repl 桥单命令 32s 上限"
  （僵尸 evaluate 危害）。

## 一条龙用法（v2：打开 → 停下等用户选 → "开始" → 直接出 HTML+PDF，零询问）

`scripts/export-driver.mjs` 把"连接 → 停 → 提取 → （可选）轮次筛选 → 渲染 → 质检"封装成脚本相位，
agent 只需逐相位调用。**注意：cell 顶层必须先跑标准 bootstrap 并把 `browser` 传参**——
import 进来的模块运行在真实 Node 域，拿不到 cell 沙箱的全局 `agent`（见踩坑清单"node_repl 双域"）。

**全程禁止 AskUserQuestion**：会话由用户在页面上自行点开，导出参数一律用默认值。
唯一例外是轮次筛选（见相位 3）——用户明确要求部分导出但没说清哪几轮时才问一次。

**相位 1 · open**（连接 + 打开页面后**必须停下**，不做任何选择与询问）：

```js
const browserPluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupBrowserRuntime } = await import(pathToFileURL(join(browserPluginRoot, "scripts", "browser-client.mjs")).href);
await setupBrowserRuntime({ globals: globalThis });
const browser = await agent.browsers.get("iab");
const { runPhase } = await import(pathToFileURL("<skill 目录>/scripts/export-driver.mjs").href);
await runPhase("open", { browser, url: "<远程链接，可省略——省略时自动读 %USERPROFILE%\\.zcode\\secrets\\zcode-remote-session.url>",
  outRoot: "D:/zcode/chat-export" });
```

返回 `waiting` 即连接成功并探活（被踢会自动点"重新连接"，最多 3 次）。此时**结束当前回合**，
只告诉用户一句："页面已打开，请在页面上点开要导出的对话，然后回复『开始』。"

**相位 2 · 用户回复"开始"后一口气跑完（不再询问、不再停顿）**：

```js
await runPhase("extract", { browser, session: "当前" });   // 导出页面上已打开的对话；timeout 设 118000
await runPhase("render", {});
await runPhase("verify", {});
```

- `session: "当前"`（或 `pick: "当前"`）= 导出页面上当前打开的对话；页面没开对话时明确报错，
  转告用户先点开对话再发"开始"。发"开始"后目标会被**钉扎**（见坑清单"桌面端切走会话"），
  用户之后切走/页面刷新都会在提取时自动重开，无需停留在页面上。
- 参数全部默认，无需传入：主题 `default`（HTML 深色 + PDF 白底）、字号 14px、A4 竖版标准留白、
  `formats: ["html", "pdf"]`（用户点名要长图时传 `formats: ["html","pdf","longpng"]` 或 `"longjpg"`；
  点名要**长页 PDF**（说"长pdf/长页pdf/一张不分页的PDF"均指此，`<名>-long.pdf` 标准矢量带文本层）
  时传 `"longpdf"`，要 A4 打印版就保留 `"pdf"`）、
  传 `theme:"both"` 深浅两套全要。
- app 3.16.2 起等稳定/滚动穿透已移出主 evaluate（driver 逐发驱动），32s 上限只剩纯计算可控占；
  代码块极多的超大会话若仍顶破，按单主题分两次提取省一半耗时。
- 深浅两主题在**一次现场流水线**里同时产出（活页面采集/稳定等待/克隆只做一遍，两份 HTML 共享
  图片 dataURL 缓存，耗时≈1.6×单份而非 2×）；`formats` 不含 pdf 且 `theme≠both` 时只产长图主题一份
  （第二主题整个跳过）。已存在的主题文件自动复用不重提取。参数在 extract 归一化保存：
  字号（改 `--ui-font-size`）/留白（body padding）/横版（@page）以 `<style id="zparams">` 块注入实现
  （复用已有文件时离线同步该块——"改参数重跑 extract"不会静默用旧排版，改完重跑 render 即生效），
  灰度/宽度/裁边在 render 传给 render.py（`--grayscale` 保留文本层、`--width`、`cropSides:false` → `--no-crop-sides`）。

**相位 3 · filter（按需——标准流程不问轮次，默认全量导出）**：不要主动问用户"导出整个对话
还是只导出某几轮"。仅当用户明确要求部分导出（"只导出第 3 条回复/最后几轮/2 到 5 轮"）时才走
filter，用户已说清就直接传 spec：

```js
await runPhase("filter", { turns: "2,5-7" });   // 语法：序号串（支持 ③、3- 与 -6 开区间、中文逗号顿号）| last3/最后N轮 | 全部/all
await runPhase("render", {}); await runPhase("verify", {});   // verify 阈值对部分导出自动放宽
```

用户要部分导出但没说清是哪几轮时，跑不带 turns 的 `runPhase("filter", {})`——返回值带 `turnsAsk`
（轮次清单用圈号单双+隔行缩进排版，👤=含提问的一轮、🤖=仅回复或系统轮；选项含 全部对话/最后1轮/
最后3轮，具体序号经"其他"输入），拿它问一次并把答案传回 filter。这是轮次问题唯一出现的场景。

原理：提取时每个轮次根（"只含该轮次的最高祖先"，见踩坑清单"轮次父层级不统一"）两侧插
`<!--ZTURN:i:s/e-->` 注释，并在活 DOM 收集轮次清单（角色+40字预览）；filter 在文件级删除未选轮次的
整棵子树（标记总落在完整元素边界，删后必然平衡），全量备份到产物目录 `.full-html/`——**改选直接重跑
filter 即可（无需重新提取）**，`turns="all"` 恢复全量；选择记录写 `turns.json`。已设筛选后重跑 extract
会自动按既有选择重滤新文件。一轮 = 一组问答（含 `data-v4-user-input-bubble` 的是用户发起轮）。

**内嵌交互工具（导出 HTML 自带）**：extract 时 `export-driver.mjs` 自动把 `export-tools.js` 注入
`</body>` 前（同源图片也已就地下成 dataURL、懒加载属性剥除并补 width/height，文件完全自包含、
断网可用）。浏览器打开 HTML 即见：每轮**上方的"第N轮"复选签**（文档流内联、未勾选轮变暗）+
右上工具条（全选/清空/🖨 PDF/🖼 PNG）。
- 复选签是轮次根的前一个兄弟节点（正常文档流），随内容移动、永不漂移——v1 用"覆盖层+
  getBoundingClientRect 快照"定位，定时器/resize 窗口外的布局变化（懒图解码、改窗口宽）会让
  浮签越偏越多，实测 820px 宽累计漂 363px，已废弃该架构；
- 🖨 PDF＝未选轮打 `.ztools-off` 后 `window.print()`，沿用导出的 A4 分页规则（对话框里选"另存为 PDF"）；
- **页面内没有长页 PDF 出口（v4 移除）**：固定尺寸的标准长页 PDF（矢量+文本层、可选中搜索）
  只有无头打印管线能给——`render.py --longpdf` 走 `--print-to-pdf`，`@page` 定高在无头路径被
  完整尊重；带 UI 的打印对话框则受纸张下拉覆盖（Chromium issue 41010929），而绕开对话框的
  客户端直出只能是 canvas→JPEG 光栅封装（v3 试过，无文本层，已否决移除）。需要长页 PDF 由
  agent 跑管线产出 `<名>-long.pdf`；
- 🖼 PNG＝SVG foreignObject → canvas 生成长图（默认 2x，内容过长自动降档），所见即所选，
  文件名带 `-选N_M` 后缀；PNG 内字体回退系统字体栈（远程 @font-face 在 foreignObject 中不加载），
  聊天记录本身的文字/代码/配色（oklch、color-mix）全部原生支持；
- 选择状态按 文件名+会话指纹 存 localStorage（file:// 下所有本地文件同源，只按文件名做键会让
  同名导出互相串选择）；
- 无头渲染（render.py 长图/逐页）时复选签/工具条由 `._render.html` 渲染副本显式隐藏——screen
  媒体下 `@media print` 藏不住它们；headless=new 的 navigator.webdriver 是 false，不能当无头判据。

**相位 4 · render + 相位 5 · verify**：

```js
await runPhase("render", {});   // 按参数并行渲染并归档
await runPhase("verify", {});   // 脚本质检（页数/乱码/输入坞/长图非空/灰度/横版 + layout-check 排版断言）
```

产物按 `formats` 与主题归档到 `<outRoot>/<会话名>-<时间戳>/`：`<会话名>.html`（网页还原副本，右上角切浅色，
内嵌轮次复选框 + PNG 长图与 PDF 打印工具）、
`<会话名>.light.html`、`<会话名>-long.png`（深色长图）/`-light-long.png`（浅色）、`<会话名>.pdf`（浅色白底）/
`-dark.pdf`（深色）、`<会话名>-long.pdf`（深色长页 PDF）/`-light-long.pdf`（浅色）、`<会话名>-long.jpg`、
`pages/`（A4 PDF 逐页 PNG，验收用）、`lp-*.png`（长页 PDF 逐页 PNG，验收用）。theme="both" 时深浅长图、
长页 PDF 与 A4 PDF 全出；只选 JPG 时 PNG 为中间产物自动清理。verify 内置 layout-check 排版断言
（DOM 几何 / 栅格空洞 / 轮次与行号交叉核对，见下），需人工留意的项以 warns 返回。
跨相位状态存系统临时目录 `._chat-export-state.json`（路径固定，不随 outRoot 变；只存 sid/origin/参数等
非敏感字段——**远程链接不落入状态文件**，用时从 `%USERPROFILE%\.zcode\secrets\` 私密 store 现读或由 sid 重构）。

## 流水线（手动分步，调试/兜底用）

### 第 1 步：现场提取 → 独立 HTML

读取 `scripts/extract-evaluate.js`，**先把整个脚本目录拷贝到工作目录**（不要直接改已安装
skill 本体，否则 ORIGIN/OUT_FILE 会残留到下次使用），整个文件作为一个 cell 在
`mcp__node_repl__js` 里执行（浏览器 bootstrap 已包含在文件开头；执行前把工作副本顶部的
`ORIGIN` 改成目标站点域名、`REMOTE_URL_MATCH` 按需调整路径特征、`OUT_FILE` 改为落盘路径、
`SHADOW_HOSTS` 改为目标站代码块 web 组件的标签名（默认 `diffs-container`，多个用逗号分隔；
一条龙 driver 的相应参数为 `shadowHosts`）。
包内不内置任何真实网址。

脚本做的事（全部在一个页面内 evaluate，**活页面零改动**）：

1. 定位消息滚动容器（`overflow-y:auto/scroll`、`clientHeight>300`、`scrollHeight > 1.5×clientHeight`
   且含 `<p>`，取 DOM 最深者），
   记录从 `<html>` 下来的孩子索引路径；
1b. **懒加载穿透**：滚过全对话触发"结果图片"等懒加载占位符换入真图（透明 PNG 占位机制），
   回顶后重新等高度稳定；
2. 克隆整个 `<html>`：剥离 `<script>`（防止 React 在导出文件里重新挂载顶掉导出内容）、
   剥离 `link[rel=stylesheet]` 与 `<noscript>`；
3. **样式判定在活 DOM 上做**（克隆体是游离节点，`getComputedStyle` 拿不到值）：先在活页面收集
   scroller 祖先链与 fixed/app-drag 元素清单，再到克隆体内按索引路径重定位 scroller、沿祖先链打
   `data-export-keep` 标记、absolute/fixed 链上容器转 static、隐藏链外兄弟（侧边栏/顶栏/输入坞）
   与 fixed 悬浮件；
4. **递归拍平 shadow DOM**（对话里的代码块是 `<diffs-container>` web 组件，代码正文在 shadowRoot 里，
   直接 outerHTML 序列化会得到空代码块），并把 shadow CSS 以 CSSOM 方式作用域化
   （`:host` → `diffs-container`，普通选择器加前缀）；
5. 轮次转文档流（position:static + transform:none，各轮次 translateY 偏移首尾相接、间隙为 0，
   转静态后自然还原布局）；每个轮次根两侧插 `<!--ZTURN:i:s/e-->` 注释（供 export-driver 的
   filter 相位做"部分轮次导出"文件级裁剪），并在活 DOM 收集轮次清单随返回值带回；
6. 隐藏输入坞（优先 `data-v4-composer-dock` 精确属性锚点，兜底从 contenteditable 向上找分支点）
   与 `input[type=file]`；
7. `blob:` 图片转 dataURL；
8. 组装 `<head>`：`<meta charset>` 放最前 → 主 CSS 内联（url 重写为绝对地址）→ shadow 作用域 CSS +
   导出规则（高度解锁、`content-visibility: visible`、`html/body` 深色背景、分页规则、
   `@page A4 portrait`）。

Node 侧落盘时**必须加 `<!doctype html>` 前缀**（documentElement.outerHTML 不含 doctype，
缺了会进 quirks 模式）。

产物：`conversation-export.html`。**此文件是后续一切迭代的唯一输入。**

### 第 2 步：离线渲染 PDF + 长图 + 长页 PDF

运行 `scripts/render.py`（依赖 pymupdf、PIL、numpy：`pip install pymupdf pillow numpy`；Edge 路径按需改脚本内 `EDGE` 常量）：

```bash
python render.py conversation-export.html --out-dir ./out            # A4 PDF + 长图
python render.py conversation-export.html --out-dir ./out --longpdf  # 额外出长页 PDF
python render.py conversation-export.html --out-dir ./out --longpdf --skip-longpng  # 不要长图时省时
```

- PDF：Edge 无头 `--print-to-pdf --no-pdf-header-footer --hide-scrollbars`；
- 长图：Edge 无头 `--screenshot --window-size=1280,<H>`（H 按 PDF 页数×1123px×1.15 + 400 估算、
  下限 7600、上限 80000；底部有内容则 ×1.5 加高、封顶 4 次。约 65 页以上的会话长图不可用
  ——触底超上限会明确报错，PDF 不受影响），再按页面底色裁掉尾部空白；
- 长页 PDF：见下节；
- 同时输出 A4 PDF 每页 PNG（dpi=110，`page-*.png`）与长页 PDF 每页 PNG（`lp-*.png`）供验收；
- 独立 `--user-data-dir` 防被已开实例接管；**Edge 154+ 启动器进程会先于渲染任务退出**，
  产物是否就绪必须轮询等待（`wait_for_file`，尺寸连续两采样稳定），且**产物落盘前不得删
  临时 profile**——分离的浏览器进程还在用，profile 随删任务随死、产物永不出现；
  产物路径必须绝对路径。

#### 长页 PDF（--longpdf）

整场对话打进**一张按内容定高的超长页**（无分页），视觉等同长图的 PDF 版：

- 原理：渲染副本把 `@page` 覆写为 `size: <W>px <H>px; margin:0`（注在文档末尾，天然压过
  head 里的 A4/横版规则）。W/H 取自 A4 PDF 实际页面尺寸（portrait 794 / landscape 1123，
  自动跟随 zparams 横版，≥768 保住 md 断点）；H 初值按 A4 页数估算，渲染后多页就按
  "观测页数×页高×1.05"收敛加高重试（下轮必单页）。
- 裁尾：估算高必 ≥ 真实内容高，单页渲染后用 pymupdf 按"最后墨迹行 + 30px"收 CropBox
  （文本层原样保留、零重编码），同时把页右缘/底缘的 1px 打印残迹裁掉（见踩坑清单）。
- **单页上限 18900px**：PDF 规格页尺寸上限 200 英寸 = 14400pt = 19200px，超出属未定义行为
  （Adobe Acrobat 直接拒开；Edge/Chrome/PDFium 正常）。内容更高时自动降级为**分段长页**：
  按上限高度自然分页（每段 ≈ 17 张 A4，断点可能落在轮次中间），末段裁尾、verify 会以
  warns 标明分段。
- 末行 stdout 输出 `LONGPDF {json}`（mode: single|chunked、pages、widthCss、heightCss），
  driver render 相位解析后写进 `products.longPdfs` 供 verify 与归档。

**为什么竖版能保住桌面布局**：A4 竖版纸宽 794px ≥ 768px（md 断点），`max-md:` 移动端变体
不会命中。此前翻车是因为页边距把打印布局视口压到 726px < 767px，触发了移动端断点
（气泡退化成左对齐裸文本、附件缩略图竖堆）。方案：`@page { size: A4 portrait; margin: 10mm 0 }`
——左右边距 0 保持打印视口等于整张纸宽，深色背景顺势铺满纸面（无白边，上下 10mm 由画布背景
填充），视觉留白由 body 自身 padding 提供
——padding 不影响媒体查询视口。两个配套项缺一不可：`html` 也要设深色背景（body 之外的区域
否则是白的）；长图按 1280 宽渲染走的是真实屏幕媒体，不受 @page 影响。

### 第 3 步：排版质检（layout-check.py，无 agent / 无视觉模型）

```bash
python scripts/layout-check.py <产物文件夹>
```

三层确定性检查，全部可重复、纯脚本：

- **DOM 几何断言**：往 HTML 副本注入断言脚本 + 报告脚本，Edge 无头 `--print-to-pdf` 后从
  **PDF 元数据 Title** 回传 JSON（hex 编码；Edge 154+ 的 `--dump-dom` stdout 随启动器早退，
  已废弃，见踩坑清单）——横向溢出 / 破图（naturalWidth=0）/ 可见 fixed 泄漏 / 输入坞 / 编辑铅笔 /
  代码块两栏网格对齐（gutter 与 content 必须同顶并列）/ 轮次叠压 / 折叠文本 / 裁剪文本；
- **栅格分析**（numpy 直接算 PNG）：内部背景空洞 >220px（破图被打印管线吞卡的特征性空白）、
  空白页、调色板（深色漂白/浅色漂黑——仅对长图做，`pages/` 逐页 PNG 不做）、
  长图顶部留白与内容贴裁剪边；
- **HTML↔PDF 交叉核对**（pymupdf）：每一轮的文本必须在 PDF 里找得到（整卡消失即失配）；
  代码行号最长连续序列两边必须一致（行号栏丢失/上下堆叠即失配）。

有 fails 退出码 1；warns 是需人工留意项（如代码块横向滚动属应用自身设计）。历史上靠验收代理
"看图"才发现的故障模式（行号堆叠、整卡消失、输入坞泄漏、主题漂白、fixed 泄漏、空洞）现已全部
有对应断言，破坏性验证（人为藏行号栏/藏轮次/插 420px 空洞）均被准确检出、正常产物零误报。
人工/子代理目检降级为可选兜底（warns 提示处）。

不通过 → 只改独立 HTML（补 `<style>` 追加规则即可，追加在 s2 之后天然覆盖）→ 重跑 render.py → 再检。

### 兜底：代码块两栏补丁

若验收发现行号栏与代码栏上下堆叠（说明 shadow CSS 收集不完整，常见于会话已死无法重新提取），
把 `scripts/diffs-fallback.css` 的内容注入 HTML 文档末尾（闭合 body 标签之前；不要锚定
第一个闭合 head/body 标签，理由见踩坑清单"注入锚点被源码注释抢命中"），手工重建两栏网格。

## 踩坑清单（每条都真实付出过一轮返工）

| 坑 | 症状 | 根因与修法 |
|---|---|---|
| 登录门（app 3.16.2+） | 打开远程链接停在标题 "ZCode - Web Remote Control Sign In"、h1 "登录后继续使用 Web 远程控制"，只有 "连接 Z.ai/连接 BigModel" 两个平台按钮；脚本按旧逻辑探活会一直在非对话页空转 | 新版裸 sid 链接不再直接进控制页：须选与电脑端相同平台走 OAuth（zcode.z.ai → bigmodel.cn/z.ai 登录，含手机验证码/微信扫码/拼图验证），且**账号必须与桌面端一致**，登录后自动跳回远程链接。ensureUsable 已加 loginGate 检测（h1 文案 + 平台按钮双信号），命中即明确报错让用户人工登录；登录态存 IAB profile，之后免登 |
| url 重写双引号 | CSS 在 @font-face 处整体截断，只剩前 72 条规则，主题变浅色 | 重写正则的替换串不能再加一个引号：必须写 `'url($1https://…'` 复用捕获的引号，产物里会出现 `url(""https://…)`，这个非法字符串会吞掉其后全部 CSS |
| 根相对路径 | 导出后无任何工具类样式，全是裸文本 | 页面 CSS 是 `<link href="/remote/...">`，file:// 下解析到盘符根目录 404。必须把 cssRules 全量内联，并把 `url(/remote/…)` 重写为绝对地址 |
| quirks 模式 | 布局行为异常 | `documentElement.outerHTML` 不含 doctype，落盘时手动补 `<!doctype html>`；`<meta charset>` 要放在大段内联样式之前 |
| shadow CSS 泄漏 | 行内 `<code>` 变成横跨整行的灰块 | shadow 里的样式被拍平进全局后，`code {}` 等规则命中全文档。必须逐条选择器加宿主前缀（用 CSSOM 走 `scopeRules`，不要用正则改文本——正则会把 `@layer rendered` 当选择器加前缀，整块作废） |
| @layer 块被跳过 | shadow 样式收集结果为空 | `CSSLayerBlockRule.type` 不在旧枚举里，按 type 分支会漏；按 `constructor.name` 分派，分组规则（@media/@supports/@layer 块）递归处理，`CSSLayerStatementRule` 直接丢弃 |
| content-visibility | 某代码块/长段落整块空白 | 组件用了 `content-visibility: auto`，离屏内容不渲染。导出规则里全局 `content-visibility: visible !important` |
| prefers-color-scheme | 导出变浅色主题 | `dark:` 工具类包在媒体查询里，无头 Edge 默认 light。若仅靠类名的变量没丢，逐项检查媒体查询包裹的规则是否需要展开 |
| 移动端断点 | 气泡变左对齐裸文本、缩略图竖堆 | 9mm 页边距会把打印视口压到 726px < 768px。用 `@page margin: 0` 保住 794px 视口，留白交给 body padding，`html` 同步设深色背景 |
| React 重渲染 | 提取中途 DOM 属性/内联样式被冲掉 | 提取在一个 evaluate 内一口气完成；不要跨多个 cell 依赖之前注入的页面状态 |
| 状态检查误报 | 检查页面是否被踢/断连时，body 全文能搜到 "KICKED"/"设备接管" 等词 | 镜像界面会显示当前会话的对话正文，而对话里可能就包含这些词（比如 assistant 的总结）。判断连接状态要看结构：`h1` 是否为"已被其他设备接管"、是否存在"重新连接"按钮，而不是 body 全文 grep |
| 破图杀死整卡 | 某类卡片（文件产物卡等）在长图里有、在 PDF 里整张消失，只留等高的空白洞 | 卡片内含 `<img src="/remote/...">` 服务器相对路径，file:// 下加载失败，Chromium 打印分片时会跳过包含破图的整个块（屏幕渲染却正常，极具迷惑性）。所有 img 的相对路径必须转绝对地址 |
| 桥接传输损坏 | 导出 HTML 里出现几个 U+FFFD 乱码，且活 DOM 里没有；重试同一位置必然复现 | 大字符串（>1MB、含非 ASCII）经 node_repl 桥接会被确定性损坏。对策：页面侧 percent-encode 成纯 ASCII 暂存 window，Node 分块取回 + 逐块校验和 + 坏块重取，最后整串校验再 decodeURIComponent |
| 输入坞隐藏失配 | 导出底部混入"提出后续修改要求"输入区 | 别把模型名（GLM-5.3-Flash 等）当隐藏匹配的标志——输入坞显示的是当前选中模型，会变。从占位符元素向上走到"其父元素包含消息滚动容器"的分支点，那个分支点就是输入坞根 |
| 新开会话只导出半场 | 9 轮对话只提取到 5 轮 | 刚打开的会话经 WebSocket 分批同步。提取前轮询滚动容器 scrollHeight，连续两次采样一致才继续 |
| 固定层级链定位失败 | 轮次没转文档流，PDF 只有 1 页 | 不同会话/加载状态下消息流的包裹层数不同，`firstElementChild` 链会指错节点。用 `[data-v4-turn-unit]` 等数据属性定位 |
| shadow CSS 白底代码卡 | 代码卡内层白底深字，夹在深色卡片框里 | shadow CSS 里也有 `@media (prefers-color-scheme: dark)`，无头 Edge 默认 light。作用域化时 dark 变体展开为无条件、light 变体丢弃 |
| 行号列消失 | 代码块行号不显示 | `:host([data-disable-line-numbers])` 这类条件宿主选择器，作用域化时若把条件丢掉就变成无条件隐藏。必须转成 `host[cond]`；同时删除拍平后子树里的 `data-disable-line-numbers` 属性 |
| 尾部空白页 | PDF 最后一页整页纯背景 | 内容恰好在页边界收尾时多出一页。渲染后检测末页是否无文本无墨迹，是则 `delete_page` 删除 |
| light-dark() 打印取 light 值 | 代码卡在长图里深色、PDF 里白底；屏幕/打印两条渲染路径自相矛盾 | shadow CSS 与内联 style 里都有 `light-dark(a,b)`（CSS Color 5 函数，随 color-scheme 解析），Chromium 打印管线强制纸张=light。提取时全部替换为主题值：CSS 规则走 CSSOM 在序列化处替换（cssText/scopeRules 内的 forceLD），内联 style 属性与页面自带 `<style>` 块在 Node 侧 decode 后兜底扫（**只扫这两处**，不扫正文——对话里可能正展示着 light-dark 示例代码；`scripts/postfix.py` 可对已有产物文件级修补，同样限定作用域） |
| 盲猜选择器浪费时间 | 隐藏输入坞/编辑按钮试了三轮通用选择器都失配 | 卡片自带精确锚点：`data-v4-composer-dock`、`data-testid="v4-edit-99"`。**先 rg 导出源文件找 data-testid/自定义属性，再写选择器**；验收代理能在源文件里直接指出这些定位符 |
| 游离克隆 getComputedStyle | 克隆体上的 absolute→static / fixed 隐藏 / app-drag 隐藏全部静默失效（输入坞泄漏多轮修不掉的真根因） | `getComputedStyle` 对脱离文档的克隆节点返回空串（连内联 position 都不反映，Edge 无头实测）。样式判定一律在**活 DOM** 上做，再按孩子索引路径把结果应用到克隆体 |
| 页面代码引用外层变量 | evaluate 直接 ReferenceError（ORIGIN/THEME 未定义），或 Node 侧引用页面变量同理 | evaluate 字符串是**两层作用域**：页面代码里只能用 `${ORIGIN}` 这类 build-time 注入的常量（文件顶部统一注入），Node 侧只能用 `FORCE_THEME` 等 Node 常量。重构改名时最易翻车——v1 打包版就同时存在 `THEME`（Node 侧未定义）与裸 `ORIGIN`（页面侧未定义）两处 |
| 组合媒体查询被无条件展开 | `(min-width:768px) and (prefers-color-scheme:dark)` 的宽度条件被静默丢掉，移动端样式漏进桌面导出 | 主题展开只针对**纯** prefers-color-scheme 查询；组合查询按子句拆分，只摘除主题子句、保留其余条件（rewriteMedia），含 or/not 的复杂条件原样保守放行 |
| 多实例 shadow 组件 | 每个代码块一个 web component 的站点，只拍平第一个，其余成空壳 | 拍平循环遍历**全部**宿主实例（同名组件的作用域 CSS 按 Set 去重）；嵌套 shadow 各用自身标签名作前缀 |
| Edge 输出目录不存在 | --print-to-pdf/--screenshot 对不存在的输出目录**静默退出（退出码 0）**，render.py 误报"被已开实例接管" | 渲染前对产物路径 `out.parent.mkdir(parents=True)`；传绝对路径且目录必须已存在 |
| data-* 主题属性残留 | 浅色导出整体正常但 CSS 里 `html[data-zcode-bootstrap-theme="light"]` 等规则不命中（html 的 data 属性还是 dark） | light 分支除类名/color-scheme 外，还要把 html 上值为 "dark" 的 `data-*` 属性统一换成 "light"（v2 已修，实测 9 页浅色验收通过） |
| node_repl 双域 | import 的 ESM 模块里拿不到 cell 沙箱全局（`agent is not defined`/桥接不可用） | cell 代码跑 VM 沙箱域、动态 import 的模块跑真实 Node 域，globalThis 不同。模块不得引用全局 agent——cell 顶层 bootstrap 后把 browser 句柄作为参数传入 |
| 表达式体箭头函数切片 | 按花括号配对切片会切进模板串内部的 `{`，产出残缺代码（missing ) after argument list） | 无函数体花括号的箭头（如 fetchChunk）用"标记→\n);"切片；带花括号体的才用括号配对 |
| 轮次父层级不统一 | 部分导出裁剪后 HTML 结构断裂、渲染散架 | 轮次标记不能贴着轮次元素插——常规轮次互为兄弟挂在列表容器下、进行中的末轮却挂在外层容器，轮间还隔着容器开闭标签。标记要包住"只含该轮次的最高祖先"（每轮向上走到父级含 >1 个轮次为止），标记才总落在完整元素边界，文件级删除任一 [s…e] 跨度（整棵子树）后必然平衡；全量先备份到 .full-html/ 再滤主文件 |
| 轮次预览取不到文本 | 轮次清单全是空预览 | innerText 与 getComputedStyle 同理，对游离克隆节点退化为空/全文——轮次清单必须在活 DOM 上收集（提取的 A 段），克隆里只做标记 |
| html2canvas 出不了图 | 内嵌 PNG 工具用 html2canvas 渲染出空白/错色块 | 站点 CSS 大量使用 oklch()/color-mix()（Tailwind v4 风格），html2canvas 1.x 解析不了这些颜色函数。客户端 DOM→PNG 改走 SVG foreignObject → canvas：Chromium 原生渲染，任何 CSS 都支持 |
| foreignObject 丢图片 | 内嵌工具生成的 PNG 里图标/缩略图消失 | SVG 以 image 方式加载时不请求任何外部资源（安全静态上下文），https 图片一律不渲染。提取时（同源上下文，fetch 无 CORS 问题）把同源图片就地下成 dataURL（单图 ≤768KB），导出文件即完全自包含 |
| 无头截图拍进工具 UI | 长图顶部混入复选框浮签/工具条 | 内嵌工具的 UI 走 screen 媒体，@media print 藏不住；而 headless=new 的 navigator.webdriver 是 false（实测），不能当无头判据。render.py 的长图渲染副本（._render.html）里显式 `#themeToggleBtn,#zturn-bar,#zturn-layer{display:none!important}` |
| 防重复检查被聊天正文误命中 | 注入/检测条件用 `html.includes("data-ztools")` 之类宽松子串，恰逢对话正文就在讨论这些标记名（转义文本 `&lt;script data-ztools&gt;` 同样含该子串），注入被误跳过 | 判定注入与否必须用完整标签串 `<script data-ztools>`；凡以"文件里是否含某标记"做开关的，都要想到导出的对话内容可能在字面上讨论这些字符串 |
| 覆盖层快照定位漂移 | v1 复选框浮签用"绝对定位覆盖层 + getBoundingClientRect 快照"，重算时机只有头 32 秒定时器/resize/load；懒图解码或改窗口宽发生在窗口之外时浮签永久错位（820px 宽累计漂 363px、越往下偏得越多），且勾选语义被位置带偏 | 交互控件跟内容走就用文档流：复选签做轮次根的前一个兄弟节点（正常流式布局），布局怎么变它就怎么跟着变，零定位代码零观察者。凡是"事后测量绝对坐标再摆浮层"的方案，都要问一句：测量窗口之外的布局变化谁负责 |
| 懒加载图无宽高 | 提取产物里 `loading="lazy"` 且无 width/height 的图，滚动到位解码瞬间撑高布局（实测最多 360px），下方内容整体下移——打印/截图的高度测量与页面内控件定位全被带偏；本机 localhost 下 dataURL 懒图 38 秒内全提前解码所以固定视口验收发现不了，file:// 下阈值不同 | 提取时剥掉 loading/fetchpriority/decoding，`await img.decode()`（限时 1.2s）后补 width/height 属性占位（CSS 显式设宽的不受影响）；src 已转 dataURL 时把 srcset 一并丢掉（否则远程 srcset 反优先级压过内联） |
| localStorage 键串扰 | file:// 下所有本地文件同源，选择状态键只按文件名做：两个不同会话的同名导出（手动管线默认名 conversation-export.html 极易撞）互相串选择 | 键掺会话指纹：文件名 + (标题+轮数+首轮文本) 的 djb2 哈希；会话增长不换键（首轮稳定），换会话必换键 |
| 逐行 any-ink 空洞漏检 | 栅格空洞检测用"该行是否存在墨点"当内容行判据，抗锯齿/卡片阴影让 ~99.7% 的行都含墨点，420px 的真空洞整段漏检 | 内容行判据必须看行墨迹**占比**（>0.5% 宽度）而非存在性；占比阈值同时天然过滤孤立噪点 |
| 注入锚点被源码注释抢命中 | 给产物 HTML 注入断言脚本时锚定"第一个 body 闭合标签"，而内嵌工具的源码注释里就含这个标签的字面量——断言脚本被插进注释文本从未执行（症状：dump 正常但 title 无结果） | 锚定 "</body></html>" 相邻对（或取末位）；被整体注入产物的脚本源码里不要出现任何闭合标签字面量，注释里提及一律用文字表述（driver 的 zparams/工具注入、render.py inject_style、layout-check 注入现均按"末次出现"锚定） |
| 结果图片是透明占位符 | 工具产物截图（"结果图片 N"）在长图里是一张带边框的空卡片；layout-check 报"内部背景空洞 ~235px" | 应用对离屏图片用 1280×720 **全透明 PNG 占位**，滚动进视口才换真图。提取前加 A0.5"懒加载穿透"：滚过全对话（步长 0.6×clientHeight、每步 120ms）触发换图，回顶后重新等高度稳定。**滚动是唯一触发方式**，属必要的环境触碰（结束即回顶，DOM 零改动） |
| 断连状态识别盲区 | 页面 h1 显示"桌面端已离线/等待桌面端确认配对"，脚本却当正常页继续提取，克隆出 0 轮次空壳 | 断连判断要覆盖全部 h1 文案："已被其他设备接管"之外还有"已离线/等待桌面端"，以及"手机连接已失效"（实测页面重载后出现：中继判手机端掉线，页面上的"重新连接"按钮点了无效——evaluate/CDP 真点击都试过，只能手机端/客户端侧恢复）（PAGE_VIEW 的 offline 正则）。重连后 h1 停在"等待配对"说明桌面端需人工确认，脚本侧只能明确报错 |
| node_repl 桥单命令 32s 上限 | 提取中途报"browser 命令 playwright 超时（32000ms）"；app 3.16.2 实测连 16 轮会话都超——旧版把等稳定轮询（最多 14×1.5s）+ 懒加载滚动穿透内嵌在主 evaluate 里，等待就占 25~40s，叠加更肥的 CSSOM 克隆必超 | 桥对任何单个 evaluate 命令限 32s。修法（2026-10-20）：把等待/滚动移出主 evaluate——extract-evaluate.js 增 PREP_SNIPPET（prep/stab/pen/backtop 四模式，每发亚秒级），driver extractOnce 在 Node 侧逐发驱动"等稳定→逐步滚到底→回顶再等稳定"，主 evaluate 只留纯计算；stable 标志改由 driver 测得后并入返回值。超时后页面侧 evaluate **变僵尸仍在跑**：立刻重跑 extract 的所有命令都会排队继续超时——先重载远程页杀僵尸再试，而重载会把配对切断成"手机连接已失效"（见上行），须手机/客户端侧恢复后才能继续 |
| 切片标记出现在注释里 | PREP_SNIPPET 切片只得到 8 字符残片、提取前置全废（node 报 `mode is not defined` 类错） | 切片用 indexOf 找声明行，而常量上方的**说明注释里写了声明行字面量**，indexOf 先命中注释。凡"按字面标记切片/锚定"的地方，标记字符串绝不能在更早位置（含注释、文档字符串）出现；改完必须跑离线切片自检（切出长度 + 四模式可编译） |
| 占位符自带引号 | 替换模式占位符后页面代码语法错误（`""stab""`），extract 全挂 | PREP_SNIPPET 里占位符写成 `const mode = "__MODE__"`（自带引号），Node 侧替换时必须连引号一起换（`replace('"__MODE__"', JSON.stringify(mode))`）；只换裸 `__MODE__` 会双重引号。坑的根源同上条：占位符的引号约定没有单一事实来源——要么占位符不带引号由替换方全权负责，要么带引号替换值就不许再带 |
| OAuth 回跳后标签视图陈旧 | 登录完成后 tabs.list()/domSnapshot() 仍显示登录页 URL/内容，脚本误判"没登录" | IAB 标签元数据与快照在跨域 OAuth 重定向后可能是陈旧缓存。验真必须用页面自身状态：`evaluate(location.href + document.title + h1)`，一切登录态/连接态判断以此为准 |
| 桌面端切走会话→远程页刷新（3.16.x 用户实测报告） | extract 提取期间页面被整页刷新回主页/切到别的会话，缓冲丢失或导出错会话 | **桌面端一离开当前会话，远程页就整页刷新**。对策（2026-10-23 起完整解决）：①**目标钉扎**——extract 开跑时把目标钉成 tid（plan 锁定 st.tid；"当前"从侧栏 bg-selected + 主区 `[data-session-id]` 现读钉入 st.pinnedTid；用户后来又换开别的对话以最新动作为准重钉）；②**每次提取尝试前核对活动会话**，不符就 PAGE_CLICK 自动重开（"刷新回主页"按 st.pinnedTid 回退重开）；③缓冲丢失（"缓冲元数据不可用"）纳入可重试。导出全程不再要求用户停留在目标对话 |
| 桥 evaluate 不调用函数值表达式 | `evaluate(fnString, arg)` 只把函数对象序列化返回（truthy 的 `[object Object]`），"点击成功"实则从未点击——后续所有依赖点击结果的逻辑全部空转 | node_repl 桥（playwright 封装）与原生 Playwright 不同：字符串函数值**不会**被自动调用、第二参无效。带参页面代码一律写成自执行 IIFE + 占位符（如 `"__TID__"`），调用方 `replace('"__TID__"', JSON.stringify(v))` 后 evaluate——与 PAGE_VIEW/PREP_SNIPPET 同款。排查手法：把返回值 String 化打进日志，看到 `[object Object]` 即中招 |
| 重开点击后就绪判据用 turns>0 | 点击目标会话后立刻放行，克隆跑在**旧会话**上——导出错会话且无任何报错（3.16.3 实测两次连错，产物内容核验才发现） | SPA 换装需 1~3s，期间旧会话未卸载、turns 本来就 >0。就绪判据必须读活动会话标记（`[data-session-id]`/侧栏 bg-selected）并要求 **tid === 目标 tid**；等不到就 40s 超时报错进重试。产物内容核验（rg 会话特征词）应成为换会话类修复的固定验收步骤 |
| 并行会话共用状态互踩 | 两个会话同时跑同一 skill：一方 open/plan 重置另一方的 target/folder；标签被切到会话列表后，另一方盲信 openedName 克隆出 0 轮次壳 | 状态文件全局共享、跨会话无锁。extract 先探活：轮次数=0 就强制重新点击目标会话；提取返回 0 轮次直接报错不落盘；并行导出多会话时逐个串行跑 |
| Python 子进程管道编码 | 会话名含 emoji 时 render/verify 相位直接 UnicodeEncodeError 崩溃（产物路径里的 emoji 进了 py 脚本的 print）；西文区域 Windows 连固定中文输出都过不去 | Windows 管道编码取区域设置（cp936/cp1252，Python ≤3.14 尤其）。driver 全部 execFile 统一注入 `PYTHONIOENCODING=utf-8`（一处改、处处愈）；三个 py 脚本顶部 `sys.stdout/stderr.reconfigure(encoding="utf-8", errors="replace")` 兜底手动执行场景 |
| 消息块渐隐遮罩静态化 | 每个回复块只显示前 ~550px，其后内容**占位但透明**（页面上半行渐隐、下方大片空白）；页数正常、栅格空洞检测不报，仅 layout-check 折叠/裁剪文本 warns——PDF 每页中部戛然而止极易误读为分页问题 | 站点 UI 给消息区加滚动渐隐 mask：3.14 是消息块（`data-v4-timeline-message-layer`）行内固定 `linear-gradient(black 0 550px, transparent 574px…)`；3.16 改为**滚动驱动动态 maskImage**（随 scrollTop 重写行内 mask，目标元素不限于 message-layer）并新增 Tailwind `[mask-image:…]` 工具类。静态化后都是永久截断；mask 不改布局高度所以高度类检测全失明。extractOnce 已内置修复（Node 侧）：**全元素**剥行内 mask-image/-webkit-mask-image（先剥 -webkit- 变体防残留悬挂前缀）+ 注入 `[data-v4-timeline-message-layer],[class*="mask-image"]{mask-image:none!important}`（同为 !important 比源顺序，注入块在文档末尾必胜）+ `[data-v4-user-input-collapsible-content]{max-height:none!important}` 解锁提问气泡折叠；遇到新变体先 rg 产物 HTML 找 mask/line-clamp 特征再打同款补丁 |
| Edge 154 启动器早退 | 无头命令退出码 0 但产物迟迟不出现或永不出现（A4/长图时好时坏、长页 PDF 必挂）；python `communicate()` 返回后立即 `out.exists()` 必为 False | Edge 154+ 无头启动器进程**先于渲染任务退出**，真实打印在分离的浏览器进程里继续；"进程退出"不再等于"产物就绪"。修法三件套：`wait_for_file` 轮询产物（尺寸连续两采样稳定才算就绪）；**产物落盘前不得删临时 profile**（分离进程还挂着 profile，随删任务随死——曾致长页 PDF 180s 等待超时）；driver execFile 超时（330s）须 > EDGE_TIMEOUT + 产物等待（120+180=300） |
| Edge 154 dump-dom 失效 | layout-check DOM 断言 `assert-no-result`；手动跑 `--dump-dom` stdout 为 **0 字节** | 同上根因：dump 输出走启动器 stdout，启动器早退即丢。修法：断言结果改走 **PDF 元数据通道**——报告脚本把 JSON 的 hex 挂到 `document.title`（Chromium 打印原样写进 /Title，1000+ 字符实测无截断），pymupdf 读 metadata 还原。PDF 文本层通道（pre 分行 hex → get_text）也试过，**实测偶发行序损坏**（还原出非法 utf-8），不能用 |
| set_cropbox 坐标系 | 长页 PDF 裁尾后只剩最后一轮（顶部内容全没），或保留的恰好是要裁掉的半页 | pymupdf `Page.set_cropbox` 用**俯视坐标**（y 从页顶向下），不是 PDF 底朝上的用户空间——按 y1−h 算保留区会拿到"底部空白段"。修法：保留顶部区域写 `Rect(x0, y0, x1, y0+h)`（已用 200×200 半页黑块实验定准） |
| 页缘打印残迹 | 长页 PDF 裁尾永远不触发（heightCss=估算原值）；墨迹分析显示"内容"一直延伸到页底 | 打印管线在页**右缘画 1px 深灰竖线**（滚动条残迹，`--hide-scrollbars` 拦不住）、**底缘也有 1px 残迹**，贯穿整页导致逐行墨迹检测每行都命中。修法：分析前剔 pixmap 四边 2px（与 page_is_blank 同法），cropbox 裁尾时顺手把右缘 2pt 裁掉 |
| 宽表格打印裁切 | 表格「原因」列在页边整列截断（A4/长页 PDF 都中招）；旧屏宽断言（1280 视口）测不出——1136px 表格 < 1280 | 表格带 w-max（width:max-content，实测 1136px）且外层包装 div 带内联 `max-width:848px`（屏幕栏宽上限）：屏幕靠容器横向滚动是设计内，打印视口 794px 时整条链超宽、右半被页边裁掉。修法（`zfix-print-table` 块，extract 时注入）：`@media print{table{max-width:100%!important}div:has(table){max-width:100%!important}td,th{overflow-wrap:break-word}}`——表格和"含表格的 div"打印时一律收进容器宽、单元格折行（:has() 需 Chromium 105+）；屏幕媒体不动保网页还原。既有产物可离线注入同款块补修 |
| 断言环境是屏幕媒体 | 打印补丁（@media print）在 DOM 断言里"不生效"（computed maxWidth=none）、宽表裁切测不出；反之 opacity-0 滚动条 UI 又把 document.scrollWidth 撑出假溢出 | `--print-to-pdf` 的**脚本执行发生在绘制前的屏幕媒体**，print 样式到绘制阶段才生效——断言测的是"窄视口屏幕布局"而非 PDF 实际布局。修法三件：① layout-check 断言副本把所有 `@media print{` 改写成 `@media all{`，测的就是打印布局；② 溢出 fail 只算"有效可见"的越界元素——`checkVisibility({opacityProperty:true})` 计入祖先链透明度（滚动条 thumb/轨道挂在 opacity-0 包装层下，子元素自身 computed opacity=1），代码块子树（diffs-container/code[data-code]）横向滚动属应用设计；③ `.sr-only` 有字无高属无障碍设计，不计折叠文本 |
| 离线补丁转义层级吃掉 \n | 升级产物内嵌脚本后工具条/复选签**整体消失**（用户报"导出按钮没了"） | 用 bash→python 多层字符串替换改内嵌 JS 时，`\n` 转义被中间层吃成真换行、写进字符串字面量=语法错误，整段 IIFE 静默死亡（页面无任何报错提示）。对策：①改内嵌脚本的离线补丁用 `chr(10)`/`chr(92)` 构造特殊字符，杜绝源码里出现字面反斜杠；②补丁后必须验证——提取 `<script data-ztools>` 做 `node --check` + 无头加载断言 `__ztools` 存在（layout-check DOM 断言已内置 ztoolsOk 检查，warn 兜底） |
| 打印对话框纸张无法锁定 | 页面内出长页 PDF 的两条路都不成立：window.print()+@page 预设时，对话框纸张/边距下拉（浏览器 UI）仍可操作，用户改纸张整份按所选纸张重新分页；canvas→JPEG→手写 PDF 直出下载（v3 `doLongPdf`/`buildPdfBytes`）能绕开对话框但是光栅版——无文本层不可选中搜索，被用户否决 | @page 只能预设尺寸、不能锁定对话框 UI（Chromium issue 41010929，Edge 同源）；无头 `--print-to-pdf` 才会完整按 @page 出纸。最终结论（v4）：**固定尺寸的标准长页 PDF（矢量+文本层）只由无头管线 `--longpdf` 提供**（cropbox 裁尾/超高分段也都在管线侧），页面内不设长页 PDF 出口；升级既有产物的内嵌脚本用"整块替换 `<script data-ztools>` 段"法，替换后 node --check + 无头断言 `__ztools` 存活 |

## 深浅色主题

提取脚本顶部 `FORCE_THEME`（"dark"|"light"）决定导出主题：light 时换 `theme-zai-light` 类 +
color-scheme:light、`light-dark(a,b)` 取 a、展开 light 媒体丢弃 dark 媒体、背景 #f8f8f8。
`ALT_FILE` 设为姊妹主题文件名时，导出 HTML 右上角自带"深/浅"切换按钮（`@media print` 与
render.py 的渲染副本中自动隐藏）。**标准做法：同一会话导两次**（dark 存 `xxx.html` 且
ALT_FILE=`xxx.light.html`；light 存 `xxx.light.html` 且 ALT_FILE=`xxx.html`），两文件互链。
render.py 的长图会自动左右裁剪到内容宽度 ±24px；触底检测：页面底色取底部行左右
边缘列的众数（body padding 保证边缘是纯底色），底部与底色差异超阈值 16 判触底、自动加高窗口
重试。极浅色表面（白卡 #fff vs #f8f8f8 三通道差和仅 21）依赖该阈值，若窗口底部恰好落在
无文字浅色卡区仍可能漏检——长图末尾完整性靠验收把关。

## 产物清单

- `out/conversation.pdf` — A4 竖版、主题铺满纸面、完整对话；
- `out/conversation-long.pdf` — 长页 PDF（`--longpdf`；整场一张按内容定高的超长页，超 18900px 自动分段）；
- `out/conversation-long.png` — 长图（裁掉尾部空白、左右裁到内容 ±24px）；
- `out/page-*.png` — A4 PDF 逐页渲染，供验收；
- `out/lp-*.png` — 长页 PDF 逐页渲染，供验收；
- 独立 HTML 本身就是"网页版对话离线副本"，可直接浏览器打开再交互式打印（🖨 PDF）。
