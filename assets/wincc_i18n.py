#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WinCC flexible / SMART 项目文本导出表（.xls/.xlsx）多语言处理器。

项目文本导出表的格式契约（WinCC flexible 导出 → Excel）：
  - 第 1 行  $_Languages
  - 第 2 行  语言名，如「4(2) 简体中文(中国大陆)」「9(2) 英语(英国)」；第 1 列＝源语言，第 2 列＝目标语言
  - 第 3 行  $_Typ(Screens) / $_Attrib(MultiLanguage)
  - 若干 // 注释行
  - 之后每行：第 1 列＝源文本（画面上显示什么就以什么为键），第 2 列＝目标语言文本
  - 文本可能被 <text>...</text> 包裹；换行是**字面反斜杠 n**（两个字符），不是真换行
  - 目标列出现 $_ignore ＝ 该源文本在工程里存在多份不同译文，导出时被替换；导入时该行被忽略，必须原样保留

三条硬规则（本脚本按它判定）：
  1. 第 1 列是匹配键——改了就对不上，绝不能动
  2. $_ignore 行照样要给译文（它是多译文冲突被导出挡掉的，不是不用翻）
  3. 一源一译：同一句源文本全表只能有一个译文，否则导回后工程里又变成多译文、下次导出又变 $_ignore

第四条是校对判据：源文本不含中文（纯编号/代号）而译文比源长 → 判 CODE_EXTRA，
即别行的功能词串到这一行了（Q10 top box 这类），应只留编号。

子命令：
  scan   --files a.xls b.xls ... --outdir DIR        列出每行的分型（未译/空译/忽略/编号/已有译文），出清单与报告
  apply  --files ... --dict 映射.tsv --outdir DIR    按映射写回目标列，出可直接导回的 xls（源是 xls 就出 xls）
  check  --src a.xls --out a_译文.xls               自检：行数/键列/忽略行/中文残留/一源一译

映射文件格式（TSV，制表符分隔，UTF-8，可带表头）：
  源文本<TAB>译文
  换行写 \n（字面两个字符）
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

TEXT_RE = re.compile(r"^<text>(.*)</text>\s*$", re.S)
CJK_RE = re.compile(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]")
# 日期/时间格式串（yyyy-M-d H:mm:ss 之类）两列本来就不一样，不能算串位
DATEFMT_RE = re.compile(r"^[yMdHmsAP:/.\s-]+$")
IGNORE = "$_ignore"


def looks_datefmt(s):
    s = s.strip()
    return len(s) >= 6 and bool(DATEFMT_RE.match(s))

# 项目文本导出表里非正文的头部行数上限（语言行/类型行/注释行）
HEADER_SCAN_LIMIT = 12

LO_KIT_CANDIDATES = [
    os.environ.get("WINCC_LO_KIT", ""),
    r"D:\DSH\Desktop\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js",
]
NODE_CANDIDATES = [
    os.environ.get("WINCC_LO_NODE", ""),
    r"D:\DSH\Desktop\resources\runtime\primary-runtime\dependencies\node\bin\node.exe",
    r"D:\DSH\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe",
]


# ───────────────────────── 文件格式 ─────────────────────────

def _find_lo_kit():
    cli = next((p for p in LO_KIT_CANDIDATES if p and os.path.exists(p)), None)
    node = next((p for p in NODE_CANDIDATES if p and os.path.exists(p)), None)
    return (node, cli) if cli and node else (None, None)


def convert(src, dst):
    """借 LibreOffice Kit 转格式（xls <-> xlsx）。返回 dst。"""
    node, cli = _find_lo_kit()
    if not cli:
        raise SystemExit(
            f"需要 LibreOffice Kit 转换 {os.path.basename(src)}，但没找到 cli.js。\n"
            "可设环境变量 WINCC_LO_KIT=<cli.js 路径> / WINCC_LO_NODE=<node 路径>。"
        )
    if os.path.exists(dst):
        os.remove(dst)
    out = subprocess.run([node, cli, "convert", "--input", src, "--output", dst],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0 or not os.path.exists(dst):
        raise SystemExit(f"转换失败（{os.path.basename(src)} -> {os.path.basename(dst)}）:\n{out.stdout}\n{out.stderr}")
    return dst


def as_xlsx(path, workdir):
    """拿到一个可被 openpyxl 读的 xlsx 路径。"""
    if path.lower().endswith(".xlsx"):
        return path
    os.makedirs(workdir, exist_ok=True)
    return convert(path, os.path.join(workdir, os.path.splitext(os.path.basename(path))[0] + ".xlsx"))


# ───────────────────────── 解析 ─────────────────────────

def parse(path, workdir):
    import openpyxl
    xlsx = as_xlsx(path, workdir)
    wb = openpyxl.load_workbook(xlsx, data_only=True)
    ws = wb.worksheets[0]

    rows = []
    for r in ws.iter_rows(values_only=True):
        # 整行保留：导入是按列对语言的，多余列必须原样带回去
        rows.append(["" if v is None else str(v) for v in r])
    for row in rows:
        while len(row) < 2:
            row.append("")

    # 头部：直到出现第一行非注释、非表头的内容
    body_start = 0
    langs = [rows[1][0] if len(rows) > 1 else "", rows[1][1] if len(rows) > 1 else ""]
    typ = ""
    for i, row in enumerate(rows[:HEADER_SCAN_LIMIT]):
        s = row[0].strip()
        if s.startswith("$_Languages"):
            continue
        if s.startswith("$_Typ(") or s.startswith("$_Attrib("):
            typ = typ or s
            continue
        if s.startswith("//"):
            continue
        if re.match(r"^\d+\(\d+\)", s):
            continue
        body_start = i
        break

    return {"path": path, "rows": rows, "body_start": body_start, "langs": langs, "typ": typ,
            "xlsx": xlsx, "sheet": ws.title}


def core_of(s):
    """去掉 <text> 包裹，返回 (是否包裹, 内容)。"""
    m = TEXT_RE.match(s)
    return (True, m.group(1)) if m else (False, s)


def classify(src, dst):
    """给一行分型。返回 (type, 说明)。"""
    if not src.strip():
        return ("EMPTY_KEY", "源文本为空")
    wrapped, core = core_of(src)
    if dst == IGNORE:
        return ("IGNORE", "多译文冲突，导出时已替换，导入会被忽略")
    if not dst.strip():
        return ("UNTRANSLATED", "目标列空")
    _, core_b = core_of(dst)
    if CJK_RE.search(core_b):
        return ("UNTRANSLATED", "目标列还是中文" if core_b.strip() != core.strip() else "目标列＝源文本")
    if not CJK_RE.search(core) and core.strip() == core_b.strip():
        return ("SAME_AS_SRC", "非中文文本，两列相同（编号/符号/日期格式）")
    if not CJK_RE.search(core) and not looks_datefmt(core) and len(core_b.strip()) > len(core.strip()):
        # 源是纯编号/代号，译文却更长 → 别行的功能词串过来了（Q10 top box 这种）
        return ("CODE_EXTRA", "源无中文，译文多出内容（疑串位，应只留编号）")
    return ("HAS_TRANS", "已有译文，需人工核错译/串位")


def scan(p):
    out = []
    for idx in range(p["body_start"], len(p["rows"])):
        row = p["rows"][idx]
        src, dst = row[0], row[1]
        if not src.strip() and not dst.strip():
            continue
        t, note = classify(src, dst)
        out.append({"row": idx + 1, "src": src, "dst": dst, "type": t, "note": note})
    return out


# ───────────────────────── 一源一译 ─────────────────────────

def conflicts(items):
    """同一源文本出现多个不同译文 → 导入后工程又变多译文。"""
    seen = {}
    for it in items:
        if it["type"] == "IGNORE":
            continue
        _, core = core_of(it["src"])
        if not core.strip():
            continue
        _, tgt = core_of(it["dst"])
        if not tgt.strip():
            continue
        seen.setdefault(core, {}).setdefault(tgt, []).append(it["row"])
    bad = {}
    for core, m in seen.items():
        if len(m) > 1:
            bad[core] = {k: v for k, v in m.items()}
    return bad


# ───────────────────────── 命令 ─────────────────────────

def cmd_scan(args):
    os.makedirs(args.outdir, exist_ok=True)
    work = os.path.join(args.outdir, "_work")
    report = []
    tsv_lines = ["文件\t行号\t分型\t源文本\t现有译文"]
    stat = {}
    for f in args.files:
        p = parse(f, work)
        items = scan(p)
        name = os.path.basename(f)
        c = {}
        for it in items:
            c[it["type"]] = c.get(it["type"], 0) + 1
            tsv_lines.append("\t".join([name, str(it["row"]), it["type"], it["src"].replace("\t", " "), it["dst"].replace("\t", " ")]))
        bad = conflicts(items)
        stat[name] = c
        report.append((name, p, items, bad))

    list_path = os.path.join(args.outdir, "待译清单.tsv")
    with open(list_path, "w", encoding="utf-8", newline="") as fh:
        fh.write("\n".join(tsv_lines) + "\n")

    md = ["# 项目文本分型报告", ""]
    total_need = 0
    for name, p, items, bad in report:
        c = {}
        for it in items:
            c[it["type"]] = c.get(it["type"], 0) + 1
        need = c.get("UNTRANSLATED", 0)
        total_need += need
        md.append(f"## {name}")
        md.append("")
        md.append(f"- 语言：{p['langs'][0]} → {p['langs'][1]}（{p['typ']}）")
        md.append(f"- 正文行 {len(items)}：未译 {need} / 已有译文 {c.get('HAS_TRANS', 0)} / 忽略 {c.get('IGNORE', 0)} / 非中文同形 {c.get('SAME_AS_SRC', 0)} / 编号行挂词 {c.get('CODE_EXTRA', 0)}")
        if bad:
            md.append(f"- ⚠ 一源多译 {len(bad)} 组（导回后工程会产生多译文，必须统一）：")
            for core, m in list(bad.items())[:20]:
                md.append(f"    - {core!r} → " + "；".join(f"{k!r}(行{','.join(map(str, v))})" for k, v in m.items()))
        md.append("")
    md.insert(1, f"共 {len(args.files)} 个表，未译合计 {total_need} 条。清单：{list_path}")
    md_path = os.path.join(args.outdir, "分型报告.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")

    print("\n".join(md))
    return 0


def load_dict(path):
    """映射：源文本 → 译文。支持 TSV（源\t译文）与 JSON（{"源":"译文"}）。"""
    m = {}
    if path.lower().endswith(".json"):
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        for k, v in raw.items():
            m[k] = v
        return m
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.rstrip("\n").rstrip("\r")
            if not line.strip() or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            k, v = parts[0], parts[1]
            if k == "源文本":
                continue
            # 表里的换行是真换行（Excel 单元格内 Alt+Enter），映射文件一行放不下，
            # 所以在映射里写 \n（字面两字符），读进来还原成真换行。
            m[k.replace("\\n", "\n")] = v.replace("\\n", "\n")
    return m


def write_book(rows, path, sheet_name="Sheet1"):
    """写 .xlsx（openpyxl）。"""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_name
    for r in rows:
        ws.append([("" if v is None else v) for v in r])
    wb.save(path)
    return path


def write_xls(src, old_rows, rows, path, sheet_name="Sheet1"):
    """写 Excel 97-2003 .xls。与源表同扩展名、同工作表名，导回软件时才认得出是哪类文本。

    首选 Excel COM：拿源表复制一份，只改变化的格子——行数、列数、格式、其他列全原样
    （xlwt 整表重建实测会吞行，394 行写完剩 393，之后整表错位）。
    没装 Excel 才退到 xlwt，且写完必须回读核对行数。
    """
    errs = []
    for fn in (_write_xls_via_com, _write_xls_via_xlwt):
        try:
            return fn(src, old_rows, rows, path, sheet_name)
        except Exception as exc:  # noqa: BLE001 - 记录后试下一条路
            errs.append(f"{fn.__name__}: {exc}")
    raise SystemExit("写 .xls 两条路都不通：\n  " + "\n  ".join(errs))


def _find_powershell():
    for name in ("powershell.exe", "pwsh.exe", "powershell", "pwsh"):
        p = shutil.which(name)
        if p:
            return p
    return None


_COM_SCRIPT = """
param([string]$Xls, [string]$Plan)
$ErrorActionPreference = 'Stop'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open($Xls)
  $ws = $wb.Worksheets.Item(1)
  foreach ($line in Get-Content -LiteralPath $Plan -Encoding UTF8) {
    if ($line.Trim() -eq '') { continue }
    $i = $line.IndexOf("`t")
    $r = [int]$line.Substring(0, $i)
    $rest = $line.Substring($i + 1)
    $j = $rest.IndexOf("`t")
    $c = [int]$rest.Substring(0, $j)
    $v = $rest.Substring($j + 1).Replace('\\n', "`n")
    $ws.Cells.Item($r, $c).Value2 = $v
  }
  $wb.Save()
  $wb.Close($true)
} finally {
  $xl.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
"""


def _write_xls_via_com(src, old_rows, rows, path, sheet_name="Sheet1"):
    """复制源表 → 用 Excel COM 只改变化的格子 → 保存。行数与格式天然不变。"""
    ps = _find_powershell()
    if not ps:
        raise RuntimeError("找不到 powershell")
    plan = []
    for i in range(max(len(old_rows), len(rows))):
        a = old_rows[i] if i < len(old_rows) else []
        b = rows[i] if i < len(rows) else []
        for c in range(max(len(a), len(b))):
            va = a[c] if c < len(a) else ""
            vb = b[c] if c < len(b) else ""
            if str(va) != str(vb):
                plan.append("%d\t%d\t%s" % (i + 1, c + 1, str(vb).replace("\n", "\\n")))
    if not os.path.exists(path) or os.path.abspath(path) != os.path.abspath(src):
        shutil.copyfile(src, path)
    if not plan:
        return path
    tmpdir = tempfile.mkdtemp(prefix="wincc_xls_")
    plan_path = os.path.join(tmpdir, "plan.tsv")
    with open(plan_path, "w", encoding="utf-8", newline="") as fh:
        fh.write("\n".join(plan) + "\n")
    script = os.path.join(tmpdir, "apply.ps1")
    with open(script, "w", encoding="utf-8-sig") as fh:
        fh.write(_COM_SCRIPT)
    out = subprocess.run([ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
                          "-Xls", path, "-Plan", plan_path],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout or "COM 写表失败").strip()[:400])
    return path


def _write_xls_via_xlwt(src, old_rows, rows, path, sheet_name="Sheet1"):
    """退化路径：xlwt 整表重建。会让格式与未引用列走样，只在没有 Excel 时用。"""
    import xlwt
    book = xlwt.Workbook(encoding="utf-8")
    # 工作表名必须与软件导出的一致（Screens / Others / Messages）——
    # 写成默认的 Sheet1，导入时软件认不出表类型，会整份跳过。
    sheet = book.add_sheet(sheet_name)
    for r_i, r in enumerate(rows):
        for c_i, v in enumerate(r):
            # 空列也要写：原表有几列就保持几列，导入侧按列对语言
            sheet.write(r_i, c_i, "" if v is None else str(v))
    if os.path.exists(path):
        os.remove(path)
    book.save(path)
    return path


def cmd_apply(args):
    os.makedirs(args.outdir, exist_ok=True)
    work = os.path.join(args.outdir, "_work")
    mapping = load_dict(args.dict)
    if not mapping:
        raise SystemExit(f"映射文件没有内容: {args.dict}")

    log = []
    applied = 0
    missing = 0
    for f in args.files:
        p = parse(f, work)
        rows = [list(r) for r in p["rows"]]
        for idx in range(p["body_start"], len(rows)):
            src, dst = rows[idx][0], rows[idx][1]
            if not src.strip():
                continue
            wrapped, core = core_of(src)
            # $_ignore 行照样要填：它是「工程里已有多个不同译文」被导出挡掉的，
            # 留着 $_ignore 等于这段文字在表里仍是源语言，导回去屏上也不变。
            if core in mapping:
                new = mapping[core]
                rows[idx][1] = f"<text>{new}</text>" if wrapped else new
                applied += 1
            else:
                # 没给译文的行：源是中文、目标也是中文/空 → 记下来
                _, core_b = core_of(dst)
                if CJK_RE.search(core) and (not core_b.strip() or CJK_RE.search(core_b)):
                    missing += 1
                    log.append(f"{os.path.basename(f)} 行{idx+1} 未给译文: {core!r}")

        stem = os.path.splitext(os.path.basename(f))[0]
        if f.lower().endswith(".xls"):
            # 源是 .xls 就出 .xls：WinCC flexible 的导入对话框按扩展名过滤，给 xlsx 会选不到
            out_path = os.path.join(args.outdir, stem + ".xls")
            write_xls(f, p["rows"], rows, out_path, p["sheet"])
            # 写完回读核对：行数与第 1 列必须与源表一致，否则整表会错位
            back = parse(out_path, work)
            if len(back["rows"]) != len(p["rows"]):
                raise SystemExit(f"写出的 {stem}.xls 行数 {len(back['rows'])} ≠ 源表 {len(p['rows'])}")
            for i in range(len(p["rows"])):
                if back["rows"][i][0] != p["rows"][i][0]:
                    raise SystemExit(f"写出的 {stem}.xls 行{i+1} 键列与源表不一致")
        else:
            out_path = os.path.join(args.outdir, stem + ".xlsx")
            write_book(rows, out_path, p["sheet"])
        log.append(f"产出: {out_path}")

    print(f"写回 {applied} 条；未给译文 {missing} 条。")
    if log:
        print("\n".join(log))
    return 0


def cmd_check(args):
    work = os.path.join(args.outdir or tempfile.gettempdir(), "_work")
    src = parse(args.src, work)
    out = parse(args.out, work)
    problems = []

    if len(src["rows"]) != len(out["rows"]):
        problems.append(f"行数不一致：原 {len(src['rows'])} / 产 {len(out['rows'])}")
    n = min(len(src["rows"]), len(out["rows"]))
    for i in range(n):
        a1 = src["rows"][i][0]
        a2 = out["rows"][i][0]
        if a1 != a2:
            problems.append(f"行{i+1} 键列（第 1 列）被改动：{a1!r} → {a2!r}")

    items = scan(out)
    for it in items:
        if it["type"] == "UNTRANSLATED":
            problems.append(f"行{it['row']} 未译/{it['note']}：{it['src'][:40]!r}")
        elif it["type"] == "IGNORE":
            # 填了才算译完；还留着 $_ignore 就是目标列仍是源语言
            problems.append(f"行{it['row']} 仍是 $_ignore（未填译文）：{it['src'][:40]!r}")
        elif it["type"] == "CODE_EXTRA":
            problems.append(f"行{it['row']} 译文多出内容（疑串位，源无中文）：{it['src'][:30]!r} → {it['dst'][:40]!r}")
    bad = conflicts(items)
    for core, m in bad.items():
        problems.append("一源多译：" + repr(core) + " → " + "；".join(map(repr, m.keys())))

    if problems:
        print(f"✗ 自检发现 {len(problems)} 处问题：")
        for x in problems:
            print("  - " + x)
        return 1
    print(f"✓ 自检通过：{n} 行，键列未动，无未译、无 $_ignore 残留、无串位、无一源多译。")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="WinCC flexible 项目文本导出表多语言处理")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="分型出清单")
    s.add_argument("--files", nargs="+", required=True)
    s.add_argument("--outdir", required=True)
    s.set_defaults(func=cmd_scan)

    a = sub.add_parser("apply", help="按映射写回")
    a.add_argument("--files", nargs="+", required=True)
    a.add_argument("--dict", required=True)
    a.add_argument("--outdir", required=True)
    a.set_defaults(func=cmd_apply)

    c = sub.add_parser("check", help="自检产物")
    c.add_argument("--src", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--outdir", default="")
    c.set_defaults(func=cmd_check)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
