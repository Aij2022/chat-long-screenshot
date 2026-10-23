# -*- coding: utf-8 -*-
"""postfix.py — 对已导出的对话 HTML 做 light-dark() 强制主题的文件级后处理。

用法: python postfix.py <html1> [html2 ...] [--light] [--no-backup]

提取脚本已在 CSSOM 规则级处理 light-dark()；本脚本兜底处理内联 style 属性与
<style> 块里的残留。只作用于这两处——不会改动对话正文里展示的代码文本（比如
聊天记录里讨论 light-dark() 的示例代码）。默认取 dark 值，--light 取 light 值；
默认先写 <file>.bak 备份。
"""
import argparse
import re
import shutil
import sys

# Windows 管道编码取区域设置——文件名含 emoji 时 print 会 UnicodeEncodeError
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# style 属性须锚定在真实标签上（<[a-z]…）——转义展示的教程代码（&lt;div style=…）不命中
SCOPED = re.compile(r'<[a-zA-Z][^>]*?\sstyle="[^"]*"|<style[^>]*>[\s\S]*?</style>')


def replace_light_dark(text: str, dark: bool) -> tuple[str, int]:
    """把 text 里的 light-dark(a,b) 替换为 b（dark=True）或 a（dark=False）。

    平衡括号解析，取第一个顶层逗号；畸形出现（无配对逗号/括号）跳过该出现、
    继续向后扫，不中断整体处理。"""
    total = 0
    needle = "light-dark("
    i = text.find(needle)
    while i != -1:
        depth = 0
        bracket = 0
        quote = None
        comma = -1
        j = i + len(needle) - 1
        while j < len(text):
            c = text[j]
            if quote:
                if c == quote:
                    quote = None  # 引号内逗号不是参数分隔符
            elif c in ("'", '"'):
                quote = c
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    break
            elif c == "[":
                bracket += 1
            elif c == "]":
                bracket -= 1
            elif c == "," and depth == 1 and bracket == 0 and comma == -1:
                comma = j
            j += 1
        if comma == -1 or j >= len(text) or depth != 0:
            i = text.find(needle, i + len(needle))
            continue
        rep = text[comma + 1: j] if dark else text[i + len(needle): comma]
        text = text[:i] + rep + text[j + 1:]
        total += 1
        i = text.find(needle, i)  # rep 里可能还有嵌套的 light-dark(
    return text, total


def process_scoped(text: str, dark: bool) -> tuple[str, int]:
    """仅对 style="..." 属性值与 <style> 块内容做替换。"""
    total = 0

    def sub(m):
        nonlocal total
        out, n = replace_light_dark(m.group(0), dark)
        total += n
        return out

    text = SCOPED.sub(sub, text)
    return text, total


def main() -> int:
    ap = argparse.ArgumentParser(description="light-dark() 文件级兜底修补")
    ap.add_argument("files", nargs="+", help="要修补的 HTML 文件")
    ap.add_argument("--light", action="store_true", help="取 light 值（默认取 dark 值）")
    ap.add_argument("--no-backup", action="store_true", help="不写 .bak 备份")
    args = ap.parse_args()

    for path in args.files:
        with open(path, encoding="utf-8") as f:
            s = f.read()
        s, n = process_scoped(s, dark=not args.light)
        if n == 0:
            # 无替换不重写：避免无谓的行尾归一化（CRLF→LF）与时间戳变更
            print(f"{path}: style 域无 light-dark 残留，跳过写入")
            continue
        if not args.no_backup:
            shutil.copy2(path, path + ".bak")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(s)
        residue = sum(m.group(0).count("light-dark(") for m in SCOPED.finditer(s))
        print(f"{path}: 替换 light-dark ×{n}, style 域残留 {residue}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
