# -*- coding: utf-8 -*-
"""台达 DVP 工程专项分析（对标 smart-* 那套）。

按需加载：所有功能都从工程文件重新解析，彼此独立。
只读，不改动工程文件。

用法（由 index.js 以子进程方式调用，也可单独跑）：
    python dvp_tools.py structure <工程.dvp>
    python dvp_tools.py usage     <工程.dvp> <器件名>
    python dvp_tools.py free      <工程.dvp>
    python dvp_tools.py diff      <旧.dvp> <新.dvp>
    python dvp_tools.py nets      <工程.dvp> [段号]
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import dvp_decode as D
import dvp_colmodel_v5 as C

# 器件前缀 → 说明
DEV_NAME = {
    "X": "输入继电器", "Y": "输出继电器", "M": "内部辅助继电器",
    "S": "步进继电器", "T": "定时器", "C": "计数器",
    "D": "数据寄存器", "E": "浮点寄存器", "F": "浮点寄存器(变体)",
    "K": "常数", "H": "十六进制常数", "P": "指针", "I": "中断",
}

# 器件容量（DVP-ES2/EX2 常见；解析用，越界的会如实标出）
CAP = {"X": 256, "Y": 256, "M": 4096, "S": 1024, "T": 256, "C": 256,
       "D": 10000, "E": 10000, "F": 10000}


def load(path):
    """读出工程并解析成 (段列表) 。"""
    data = D.read_bytes(path)
    rows = C.parse_rows(data, 16498)
    return data, rows


def render_row(cols):
    try:
        return C.render_row(cols)
    except Exception:
        return []


def walk_devices(cols):
    """遍历一行的所有操作数，产出 (器件名, 行文本)。"""
    for c in cols:
        conds, outs, _mark = c
        for grp in (conds,):
            for item in grp:
                txt = C.cond_text(item, "LD")
                for tok in D.find_all(txt, ""):
                    pass
                yield from _tokens(txt)
        for name, args in outs:
            yield from _tokens(name + " " + " ".join(args))


def _tokens(text):
    import re
    for m in re.finditer(r"\b([XYMSTCDEF])(\d{1,4})\b", text):
        yield (m.group(1), int(m.group(2)))


def cmd_structure(path):
    _data, rows = load(path)
    lines = []
    lines.append("# %s 程序结构" % os.path.basename(path))
    lines.append("")
    total_inst = 0
    for i, (h, cols) in enumerate(rows):
        insts = render_row(cols)
        nout = sum(len(c[1]) for c in cols)
        ncond = sum(len(c[0]) for c in cols)
        total_inst += len(insts)
        head = insts[0] if insts else "(空)"
        lines.append("## 段 %d" % (i + 1))
        lines.append("")
        lines.append("- 起首：`%s`" % head)
        lines.append("- 解析行数：%d，条件 %d 个，输出 %d 个，指令 %d 条"
                     % (len(cols), ncond, nout, len(insts)))
        if len(insts) > 1:
            lines.append("- 前 5 条：`%s`" % "` / `".join(insts[1:6]))
        lines.append("")
    lines.insert(2, "- 段数：%d" % len(rows))
    lines.insert(3, "- 指令总数：%d" % total_inst)
    lines.insert(4, "")
    return "\n".join(lines)


def cmd_usage(path, dev):
    import re
    m = re.match(r"^([A-Za-z])\s*(\d+)$", dev.strip())
    if not m:
        raise SystemExit("器件名形如 M100 / D200 / T0 / X14")
    pref, num = m.group(1).upper(), int(m.group(2))
    _data, rows = load(path)
    hits = []
    for i, (h, cols) in enumerate(rows):
        insts = render_row(cols)
        for ln_no, txt in enumerate(insts):
            if re.search(r"\b%s%d\b" % (pref, num), txt):
                hits.append((i + 1, ln_no + 1, txt))
    lines = ["# %s 中 %s%d 的引用" % (os.path.basename(path), pref, num), ""]
    lines.append("- 命中 %d 处" % len(hits))
    lines.append("- 器件类型：%s" % DEV_NAME.get(pref, "未知"))
    lines.append("")
    if hits:
        lines.append("| 段 | 指令序 | 指令 |")
        lines.append("|---|---|---|")
        for seg, no, txt in hits:
            lines.append("| %d | %d | `%s` |" % (seg, no, txt))
    else:
        lines.append("（该器件在程序中未被引用）")
    return "\n".join(lines)


def cmd_free(path):
    _data, rows = load(path)
    used = {}
    for _h, cols in rows:
        for pref, num in walk_devices(cols):
            used.setdefault(pref, set()).add(num)
    lines = ["# %s 器件占用与空闲" % os.path.basename(path), ""]
    lines.append("| 器件 | 类型 | 已用个数 | 最大号 | 容量 | 空闲估算 |")
    lines.append("|---|---|---|---|---|---|")
    for pref in ("X", "Y", "M", "S", "T", "C", "D"):
        nums = used.get(pref, set())
        cap = CAP.get(pref)
        mx = max(nums) if nums else 0
        free = (cap - len(nums)) if cap else None
        lines.append("| %s | %s | %d | %d | %s | %s |" % (
            pref, DEV_NAME.get(pref, ""), len(nums), mx,
            cap if cap else "未定",
            free if free is not None else "未定"))
    lines.append("")
    lines.append("## 连续空闲段（前 10 段）")
    lines.append("")
    for pref in ("M", "D"):
        nums = sorted(used.get(pref, set()))
        cap = CAP.get(pref) or 0
        if not cap:
            continue
        gaps = []
        prev = -1
        for n in nums:
            if n - prev > 1:
                gaps.append((prev + 1, n - 1))
            prev = n
        if prev < cap - 1:
            gaps.append((prev + 1, cap - 1))
        gaps = [(a, b) for a, b in gaps if b - a + 1 >= 8]
        gaps.sort(key=lambda x: x[0] - x[1])
        lines.append("- **%s**（%s）：%s" % (
            pref, DEV_NAME.get(pref, ""),
            "、".join("%s%d–%s%d（%d）" % (pref, a, pref, b, b - a + 1)
                      for a, b in gaps[:10]) or "（无 ≥8 的连续段）"))
    return "\n".join(lines)


def cmd_diff(old, new):
    _d1, r1 = load(old)
    _d2, r2 = load(new)
    lines = ["# %s → %s 差异" % (os.path.basename(old), os.path.basename(new)), ""]
    lines.append("- 段数：%d → %d" % (len(r1), len(r2)))
    n = min(len(r1), len(r2))
    changed = 0
    for i in range(n):
        a, b = render_row(r1[i][1]), render_row(r2[i][1])
        if a != b:
            changed += 1
            lines.append("")
            lines.append("## 段 %d 有变化" % (i + 1))
            lines.append("")
            lines.append("- 旧：%d 条，新：%d 条" % (len(a), len(b)))
            for k in range(max(len(a), len(b))):
                av = a[k] if k < len(a) else "(无)"
                bv = b[k] if k < len(b) else "(无)"
                if av != bv:
                    lines.append("  - 第 %d 条：`%s` → `%s`" % (k + 1, av, bv))
                    break
    if len(r1) > n:
        lines.append("")
        lines.append("## 新工程删除了段 %d–%d" % (n + 1, len(r1)))
    if len(r2) > n:
        lines.append("")
        lines.append("## 新工程新增了段 %d–%d" % (n + 1, len(r2)))
    lines.insert(2, "- 有变化的段：%d" % changed)
    return "\n".join(lines)


def cmd_nets(path, seg_no=None):
    _data, rows = load(path)
    lines = ["# %s 网络明细" % os.path.basename(path), ""]
    if seg_no:
        idx = [seg_no - 1]
    else:
        idx = range(len(rows))
    for i in idx:
        if i < 0 or i >= len(rows):
            continue
        insts = render_row(rows[i][1])
        lines.append("## 段 %d（%d 条）" % (i + 1, len(insts)))
        lines.append("")
        for k, t in enumerate(insts):
            lines.append("%d. `%s`" % (k, t))
        lines.append("")
    return "\n".join(lines)


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    what = argv[1]
    if what == "structure":
        print(cmd_structure(argv[2]))
    elif what == "usage":
        if len(argv) < 4:
            raise SystemExit("usage 需要器件名")
        print(cmd_usage(argv[2], argv[3]))
    elif what == "free":
        print(cmd_free(argv[2]))
    elif what == "diff":
        if len(argv) < 4:
            raise SystemExit("diff 需要两个工程")
        print(cmd_diff(argv[2], argv[3]))
    elif what == "nets":
        seg = int(argv[3]) if len(argv) > 3 and argv[3].strip() else None
        print(cmd_nets(argv[2], seg))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
