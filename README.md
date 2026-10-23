# chat-long-screenshot · 对话长截图

把 ZCode 远程控制页（Web Remote Control）里打开的对话，导出为与网页渲染样式一致的高保真产物：

- **网页还原 HTML** —— 深色/浅色双主题，可交互，自带"勾选轮次 → 一键 PNG/PDF"工具，完全自包含、断网可用
- **A4 竖版 PDF** —— 白底打印友好，矢量 + 可选中搜索的文本层
- **长图 PNG/JPG** —— 按内容定高的整场截图
- **长页 PDF** —— 整场对话一张按内容定高的超长页（超高分自动分段）

## 安装

把本目录放进 agent 技能目录（如 `~/.agents/skills/chat-long-screenshot`），完整流程、参数与
踩坑清单见 [SKILL.md](SKILL.md)。

依赖：Edge（无头渲染）、Python 3 + `pymupdf pillow numpy`、ZCode 浏览器桥（browser-use / node_repl）。

## 组成

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 完整流程、参数与踩坑清单（每条都真实付出过返工） |
| `scripts/export-driver.mjs` | 一条龙驱动：open → extract → filter → render → verify，含登录门检测、目标钉扎自愈 |
| `scripts/extract-evaluate.js` | 单页现场提取：克隆 DOM + 内联全部样式 + 拍平 shadow DOM + 轮次转文档流 |
| `scripts/render.py` | 离线渲染：A4 PDF / 长图 / 长页 PDF（Edge 无头） |
| `scripts/layout-check.py` | 无模型确定性排版质检（DOM 几何 / 栅格空洞 / HTML↔PDF 交叉核对） |
| `scripts/export-tools.js` | 产物内嵌交互工具（勾选轮次 → PNG/PDF） |
| `scripts/postfix.py` / `diffs-fallback.css` | 既有产物离线修补 |

## 特性

- **一次现场提取，全部离线迭代**：活页面只做一次克隆，PDF 分页/长图裁剪/样式补丁都在独立 HTML 上离线完成
- **目标钉扎自愈**：导出期间桌面端切换会话、远程页刷新都能自动重开目标对话继续导出
- **确定性质检**：排版断言（溢出/破图/输入坞泄漏/行号栏对齐/轮次交叉核对）全部脚本可重复，不依赖视觉模型
- **部分导出**：支持"只导出第 X 条回复 / 最后 N 轮 / 某几轮"，文件级裁剪、免重提取改选

## 安全约定

远程链接（含 sid）等价于电脑控制权，只存放于本机私有目录（`~/.zcode/secrets/`），
不进聊天记录、不进仓库、不进任何导出产物。包内不内置任何真实网址。
