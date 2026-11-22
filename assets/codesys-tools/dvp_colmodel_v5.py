# -*- coding: utf-8 -*-
"""dvp 反汇编 v5：两层模型。
第一层 decode_cell：5 字节格 → 结构化记号（类别/设备/值/沿/取反），不含指令名。
第二层 build_rows/render：列 → 组 → 分支，LD/AND/OR/栈指令全部由位置派生。"""
import sys, io, csv, re, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dvp_decode as D

CELLS = 12

# ── 第一层：编码 ──────────────────────────────────────────
# 第二字节 = 设备页；+0x10 是同一设备的第二个页
DEV = {0x02: "D", 0x03: "H", 0x04: "K", 0x05: "M", 0x07: "T",
       0x09: "X", 0x0A: "Y", 0x01: "C", 0x08: "E",
       0x12: "D", 0x13: "H", 0x14: "K", 0x15: "M", 0x17: "T",
       0x19: "X", 0x1A: "Y", 0x11: "C", 0x18: "E"}

FUNC = {0x00: "SET", 0x0D: "SET", 0x03: "TMR", 0x06: "DCNT", 0x07: "RST",
        0x28: "MOV", 0x29: "DMOV", 0x38: "ADD", 0x39: "DADD", 0x3A: "SUB",
        0x3B: "DSUB", 0x3C: "MUL", 0x3E: "DIV", 0x3F: "DDIV",
        0x40: "INC", 0x41: "DINC", 0x54: "RAND", 0x56: "SFTL", 0x60: "ZRST",
        0x1F: "ATMR",
        0x69: "DBON", 0x68: "BON", 0xC4: "MODWR", 0xF5: "MUL32", 0xF7: "DIV32"}

REL = {0x00: "=", 0x02: ">", 0x04: "<", 0x06: "<>", 0x08: "<=", 0x0a: ">="}


def decode_cell(rec):
    """5 字节格 → 字典。只描述「是什么」，不掺「叫什么」。"""
    b0 = rec[0]
    hi, lo = b0 & 0xF0, b0 & 0x0F
    if rec == b"\x52\x00\x00\x00\x00":
        return {"kind": "EMPTY"}
    if rec == b"\x00\x00\x00\x00\x00":
        return {"kind": "SEP"}
    if b0 == 0xFF:
        return {"kind": "FILL"}
    if hi == 0x80:
        return {"kind": "OPND", "grp": lo, "dev": DEV.get(rec[1]), "val": rec[2] | (rec[3] << 8)}
    if b0 == 0x90:
        return {"kind": "LINK", "val": rec[2] | (rec[3] << 8)}
    if hi in (0x10, 0x20, 0xB0, 0xC0):
        dev = DEV.get(rec[1])
        if dev is None:
            return {"kind": "UNK", "raw": rec.hex(" ")}
        return {"kind": "CONTACT", "dev": dev, "val": rec[2] | (rec[3] << 8),
                "edge": "P" if hi == 0xB0 else ("F" if hi == 0xC0 else None),
                "neg": hi == 0x20, "sub": lo, "page": rec[1],
                "lead": (b0 == 0x14),
                "ldfam": (b0 == 0x14 and rec[1] == 0x15)}
    if hi == 0x30:
        return {"kind": "COIL", "dev": DEV.get(rec[1]), "val": rec[2] | (rec[3] << 8)}
    if b0 in (0x42, 0x44, 0x49):
        if b0 == 0x42 and rec[2] == 0x18:
            return {"kind": "HDR"}
        return {"kind": "FUNC", "code": rec[2], "tail": rec[3]}
    if hi == 0xE0:
        if rec[1] == 0x10 or (rec[2] & 0xFE) in REL:
            return {"kind": "CMP", "rel": rec[2] & 0xFE, "d32": bool(rec[2] & 0x01), "page": rec[1]}
        return {"kind": "FUNC", "code": rec[2], "tail": rec[3]}
    if hi == 0x50:
        return {"kind": "MARK", "m": b0, "v": rec[1]}
    if b0 == 0x0B:
        return {"kind": "MARK", "m": 0x0B, "v": 0}
    if hi in (0x60, 0xD0):
        return {"kind": "MARK", "m": b0, "v": rec[1]}
    return {"kind": "UNK", "raw": rec.hex(" ")}


def fmt_opnd(c):
    if not c.get("dev"):
        return "?%02X" % (c.get("val") or 0)
    base = "%s%s" % (c["dev"], D.disp_num(c["dev"], c["val"]))
    return ("K%d%s" % (c["grp"], base)) if c.get("grp") else base


# ── 第一层到第二层的桥：列 → (条件, 输出, 标记) ──────────────
def parse_col(cells, head=None, pending=None):
    conds, outs, mark = [], [], None
    pending = list(pending) if pending else []
    if head:
        if isinstance(head[1], dict):
            head[1]["_g"] = 0
        conds.append(tuple(head) + (0,))
    i, n = 0, len(cells)
    while i < n:
        c = decode_cell(cells[i])
        k = c["kind"]
        if k in ("EMPTY", "SEP", "FILL", "LINK", "HDR"):
            i += 1
            continue
        if k == "MARK":
            if c["m"] == 0xD2:
                outs.append(("NP", []))
                i += 1
                continue
            if c["m"] in (0x54, 0x56, 0x57, 0x59, 0x68, 0x0B, 0x61, 0x5A, 0x34, 0x39):
                mark = (c["m"], c["v"], i)
                i += 1
                continue
            i += 1
            continue
        if k == "FUNC":
            nm = FUNC.get(c["code"]) or D.CMD_MAP.get(c["code"]) or D.guess_cmd(c["code"]) or ("??%02X" % c["code"])
            if c["tail"] == 0x10 and nm in ("INC", "DINC"):
                nm += "P"
            args = pending[:]
            pending = []
            i += 1
            while i < n:
                cc = decode_cell(cells[i])
                if cc["kind"] == "LINK":
                    if args and args[-1].startswith("K"):
                        try:
                            lo = int(args[-1][1:])
                            args[-1] = "K%d" % (lo | (cc["val"] << 16))
                        except ValueError:
                            pass
                    i += 1
                    continue
                if cc["kind"] == "OPND":
                    args.append(fmt_opnd(cc))
                    i += 1
                    continue
                break
            outs.append((nm, args))
            continue
        if k == "COIL":
            outs.append(("OUT", [fmt_opnd(c)]))
            i += 1
            continue
        if k == "CMP":
            args = []
            i += 1
            while i < n:
                cc = decode_cell(cells[i])
                if cc["kind"] == "LINK":
                    i += 1
                    continue
                if cc["kind"] == "OPND":
                    args.append(fmt_opnd(cc))
                    i += 1
                    continue
                break
            conds.append(("CMP", REL.get(c["rel"], "?%02x" % c["rel"]), args, c["d32"], i))
            continue
        if k == "CONTACT":
            c["_g"] = i          # 记录该条件所在格号（0-11）
            conds.append(("CP", c, i))
            i += 1
            continue
        if k == "OPND":
            pending.append(fmt_opnd(c))
            i += 1
            continue
        i += 1
    return conds, outs, mark, pending


# ── 第二层：位置 → 指令名 ───────────────────────────────
def cp_name(c, kind):
    """kind: 'LD' / 'AND' / 'OR' —— 只由位置决定，编码层只给设备/沿/取反。"""
    d = c["dev"]
    v = D.disp_num(d, c["val"])
    s = "%s%s" % (d, v)
    if c.get("grp"):
        s = "K%d%s" % (c["grp"], s)
    edge, neg = c.get("edge"), c.get("neg")
    base = {"LD": ("LDP" if edge == "P" else "LDF" if edge == "F" else "LDI" if neg else "LD"),
            "AND": ("ANDP" if edge == "P" else "ANDF" if edge == "F" else "ANI" if neg else "AND"),
            "OR": ("ORP" if edge == "P" else "ORF" if edge == "F" else "ORI" if neg else "OR")}[kind]
    return "%s %s" % (base, s)


def cond_text(c, kind):
    if c[0] == "HEAD":
        cc = c[1]
        if cc[0] == "CMP":
            k = ("D" if cc[3] else "") + "LD"
            return "%s%s %s" % (k, cc[1], " ".join(cc[2]))
        return cond_text(cc, "LD")
    if c[0] == "CP":
        return cp_name(c[1], kind)
    if c[0] == "CMP":
        k = ("D" + kind) if c[3] else kind
        return "%s%s %s" % (k, c[1], " ".join(c[2]))
    if c[0] == "BLK":
        return cp_name(c[1], "LD")
    return str(c[1])


def _is_ld_fam(c):
    if c[0] == "BLK":
        return True
    if c[0] == "CP":
        return c[1].get("lead") or (c[1].get("dev") and False)
    return False


def split_common(b):
    """首组条件里出现沿触点/比较时，前面的条件属于公共主链（MPS 之前）。"""
    g = b[0]
    conds = g["main"][0]
    if len(conds) < 2 or g["subs"]:
        return [], b
    idx = None
    for i, c in enumerate(conds):
        if c[0] == "CP" and c[1].get("lead"):
            idx = i
            break
    if idx is None:
        for i, c in enumerate(conds):
            if c[0] == "CMP":
                idx = i
                break
            if c[0] == "CP" and c[1].get("edge") is not None:
                idx = i
                break
    if idx is None:
        return [], b
    if _is_ld_fam(conds[0]):
        return [], b
    if idx == 0 and STRAT2.get("split0"):
        pre = [cond_text(conds[0], "AND")]
        ng = {"main": (conds[1:], g["main"][1], g["main"][2]),
              "subs": g["subs"], "start0b": g["start0b"]}
        return pre, [ng] + b[1:]
    pre = [cond_text(c, "AND") for c in conds[:idx]]
    ng = {"main": (conds[idx:], g["main"][1], g["main"][2]),
          "subs": g["subs"], "start0b": g["start0b"]}
    return pre, [ng] + b[1:]


def build_groups(cols):
    groups = []
    i, n = 0, len(cols)
    while i < n:
        c = cols[i]
        mk = c[2][0] if c[2] else None
        g = {"main": c, "subs": [], "start0b": (mk in (0x0B, 0x57))}
        j = i + 1
        while j < n:
            smk = cols[j][2][0] if cols[j][2] else None
            if smk == 0x68 or (smk in (0x0B, 0x57, 0x5A) and len(cols[j][0]) == 1):
                g["subs"].append(cols[j])
                j += 1
                continue
            break
        groups.append(g)
        i = j
    return groups


def build_legs(groups):
    """按 WPLSoft 的 leg 模型展开：主链一个 leg，每个并联块各自成 leg。"""
    legs = []
    for g in groups:
        legs.append([{"main": g["main"], "subs": [], "start0b": g["start0b"]}])
        for s in g["subs"]:
            legs.append([{"main": s, "subs": [], "start0b": False}])
    return legs


ADDR_RE = re.compile(r"[DXMYTCSH]\d{1,4}(?:\.\d)?")
BIT_RE = re.compile(r"[MXYTC]\d{1,4}(?:\.\d)?")


def _addrs(text):
    return set(ADDR_RE.findall(text or ""))


def _bits(text):
    return set(BIT_RE.findall(text or ""))


def _cond_addrs(b):
    s = set()
    for g in b:
        for c in g["main"][0]:
            s |= _addrs(cond_text(c, "AND"))
        for sub in g["subs"]:
            for c in sub[0]:
                s |= _addrs(cond_text(c, "AND"))
    return s


def _cond_bits(b):
    s = set()
    for g in b:
        for c in g["main"][0]:
            s |= _bits(cond_text(c, "AND"))
        for sub in g["subs"]:
            for c in sub[0]:
                s |= _bits(cond_text(c, "AND"))
    return s


def _out_bits(b):
    s = set()
    for g in b:
        for name, args in g["main"][1]:
            s |= _bits(" ".join([name] + args))
        for sub in g["subs"]:
            for name, args in sub[1]:
                s |= _bits(" ".join([name] + args))
    return s


def _out_addrs(b):
    s = set()
    for g in b:
        for name, args in g["main"][1]:
            s |= _addrs(" ".join([name] + args))
        for sub in g["subs"]:
            for name, args in sub[1]:
                s |= _addrs(" ".join([name] + args))
    return s


def _has_par(b):
    """分支内是否有并联支路组（0b/57 附加组或 subs）。"""
    return any(g["subs"] or g["start0b"] for g in b)


def merge_chains(groups):
    """列 → 分支。54 列开一条输出链，其后的 56/59 无条件列并入该链；
    无条件的 56 列接在 59 或其它条件列之后时自成一个无条件分支。"""
    marks = [(g["main"][2][0] if g["main"][2] else None) for g in groups]
    brs = []
    prev_mark = None
    for idx, g in enumerate(groups):
        conds, outs, mark = g["main"]
        mk = marks[idx]
        if g["start0b"] and brs:
            brs[-1].append(g)
            continue
        prev_is61 = idx > 0 and marks[idx - 1] == 0x61
        next_is61 = idx + 1 < len(marks) and marks[idx + 1] == 0x61
        if conds:
            if (mk == 0x61 and not prev_is61 and not next_is61 and brs
                    and STRAT2["iso61"]):
                brs[-1].append(g)
            else:
                brs.append([g])
        elif brs and prev_mark in (0x54, 0x56):
            brs[-1].append(g)
        else:
            brs.append([g])
        prev_mark = mk
    return brs


def render_branch(b, with_out=True, anb_ctx=True):
    out = []
    need_anb = False
    need_orb = False
    anb_done = False
    tails = []
    simple = (with_out and STRAT2["interleave"] and all(
        not g["subs"] and not g["start0b"]
        and not (g["main"][0] and g["main"][0][0][0] == "BLK") for g in b)
        and any(g["main"][0] for g in b[1:]))
    if (STRAT2.get("nestedlayers") and with_out and b
            and len(b[0]["main"][0]) > 1 and not b[0]["subs"]):
        conds = b[0]["main"][0]
        opened = 0
        for k, c in enumerate(conds):
            brk = (k > 0 and (c[0] == "CMP" or (
                c[0] == "CP" and (c[1].get("edge") or c[1].get("neg") or c[1].get("lead")))))
            if brk:
                out.append("MPS")
                opened += 1
            kind = "LD" if k == 0 and _has_par(b) else "AND"
            out.append(cond_text(c, kind))
        for g in b:
            for name, args in g["main"][1]:
                out.append(" ".join([name] + args))
            for s in g["subs"]:
                for name, args in s[1]:
                    out.append(" ".join([name] + args))
        for _ in range(opened):
            out.append("MPP")
        return out
    for gi, g in enumerate(b):
        conds, outs, mark = g["main"]
        subs = g["subs"]
        has54 = bool(mark) and mark[0] == 0x54
        lastc = conds[-1] if conds else None
        is_edge = bool(lastc) and lastc[0] == "CP" and lastc[1].get("edge") is not None
        is_cmp = bool(lastc) and lastc[0] == "CMP"
        use_tail = (len(conds) > 1 and not has54
                    and ((gi == 0 and is_edge) or (gi > 0 and is_cmp)))
        # 有并联块时，主链最后一个条件属于"块合并之后"的尾巴条件
        if subs and len(conds) > 1 and not has54:
            use_tail = True
        if STRAT2["tail_all"] and gi > 0 and conds and not has54:
            use_tail = True
        entry = conds[:-1] if use_tail else conds
        tail = conds[-1] if use_tail else None
        split = 1 if (subs and len(entry) > 1) else 0
        # 主链完整先出：真值里 "LD 主链条件... | 并联块(以 LD 开头) | ORB | ... | ANB"
        for k, c in enumerate(entry):
            if c[0] == "BLK":
                out.append(cond_text(c, "LD"))
                continue
            kind = "LD" if (_has_par(b) or subs) and k == 0 else "AND"
            out.append(cond_text(c, kind))
        for s in subs:
            if len(s[0]) > 1:
                for kk, cc in enumerate(s[0]):
                    out.append(cond_text(cc, "LD" if kk == 0 else "AND"))
                out.append("ORB")
                need_orb = True
            else:
                out.append(cond_text(s[0][0], "OR"))
            need_anb = True
        if tail is not None and tail[0] == "CMP":
            out.append(cond_text(tail, "AND"))
        elif tail is not None:
            tails.append(tail)
        if gi > 0 and g["start0b"]:
            out.append("ORB")
            need_anb = True
        if simple:
            for name, args in g["main"][1]:
                out.append(" ".join([name] + args))
    if need_anb and not anb_done and anb_ctx:
        out.append("ANB")
    for t in tails:
        out.append(cond_text(t, "AND"))
    if with_out and not simple:
        for g in b:
            for name, args in g["main"][1]:
                out.append(" ".join([name] + args))
            for s in g["subs"]:
                for name, args in s[1]:
                    out.append(" ".join([name] + args))
    return out


def render_row(cols):
    groups = build_groups(cols)
    branches = build_legs(groups) if STRAT2.get("legs_data") else merge_chains(groups)

    def hascond(b):
        return any(len(g["main"][0]) or any(len(s[0]) for s in g["subs"]) for g in b)

    def hasout(b):
        return any(g["main"][1] for g in b)

    def is_blk(b):
        return bool(b[0]["main"][0]) and b[0]["main"][0][0][0] == "BLK"

    out = []
    i, n = 0, len(branches)
    prev_bits = set()
    had_out = False
    while i < n:
        b = branches[i]
        hc, ho = hascond(b), hasout(b)
        if hc and not ho:
            out.extend(render_branch(b, with_out=False))
            i += 1
            continue
        if not hc:
            for g in b:
                for name, args in g["main"][1]:
                    out.append(" ".join([name] + args))
            prev_bits |= _out_bits(b)
            had_out = True
            i += 1
            continue
        seg = [b]
        j = i + 1
        while j < n:
            nb = branches[j]
            n_hc, n_ho = hascond(nb), hasout(nb)
            if n_hc and n_ho:
                if is_blk(nb):
                    break
                if _cond_bits(nb) & prev_bits:
                    break
                seg.append(nb)
                j += 1
                continue
            if not n_hc:
                pm = seg[-1][0]["main"][2]
                if pm and pm[0] == 0x61:
                    seg.append(nb)
                    j += 1
                    continue
            break
        out.extend(render_segment(seg, j < n and not is_blk(branches[j]), had_out))
        for x in seg:
            prev_bits |= _out_bits(x)
        had_out = True
        i = j
    return out


def _layer_split(brs):
    """61 标记的分支开启内层组，54 标记关闭内层。返回 [(外层分支, 内层分支表)]。"""
    layers = []
    cur_o, cur_i = [], None
    for b in brs:
        mk = b[0]["main"][2][0] if b[0]["main"][2] else None
        if cur_i is not None and mk == 0x54:
            layers.append((cur_o, cur_i))
            cur_o, cur_i = [], None
        if mk == 0x61 or cur_i is not None:
            if cur_i is None:
                cur_i = [b]
            else:
                cur_i.append(b)
        else:
            cur_o.append(b)
    layers.append((cur_o, cur_i))
    return layers


STRAT = {"last": "B", "blk": "A", "ao": True}
STRAT2 = {"tail_all": False, "interleave": False, "iso61": True, "legs_all": False, "legs_data": False}


def _lastmpp(tail_after, tails):
    return {"A": (not tail_after and not tails),
            "B": (not tail_after),
            "C": (not tails),
            "D": True}[STRAT["last"]]


def _blkcond(tail_after, tails):
    return {"A": bool(tail_after or tails),
            "B": bool(tails),
            "C": False}[STRAT["blk"]]


def _has_action(b):
    for g in b:
        if g["main"][0] or g["main"][1]:
            return True
        for s in g["subs"]:
            if s[0] or s[1]:
                return True
    return False


def render_segment(seg, tail_after, after_out=False):
    def hascond(b):
        return any(len(g["main"][0]) or any(len(s[0]) for s in g["subs"]) for g in b)

    out = []
    blk = None
    if bool(seg[0][0]["main"][0]) and seg[0][0]["main"][0][0][0] == "BLK":
        b0 = seg[0][0]
        blk = cond_text(b0["main"][0][0], "LD")
        nm = (b0["main"][0][1:], b0["main"][1], b0["main"][2])
        seg[0] = [{"main": nm, "subs": b0["subs"], "start0b": b0["start0b"]}] + seg[0][1:]
    if blk:
        out.append(blk)
    has61 = any(b[0]["main"][2] and b[0]["main"][2][0] == 0x61 for b in seg)
    if has61:
        brs, tails = list(seg), []
    else:
        brs = [x for x in seg if hascond(x)]
        tails = [x for x in seg if not hascond(x)]

    def emit_tails():
        for t in tails:
            for g in t:
                for name, args in g["main"][1]:
                    out.append(" ".join([name] + args))

    N = len(brs)
    if N == 0:
        emit_tails()
        return out
    if N == 1:
        pre, br2 = split_common(brs[0])
        out.extend(pre)
        if (bool(blk) or (STRAT["ao"] and after_out)) and _blkcond(tail_after, tails):
            out.append("MPS")
            out.extend(render_branch(br2))
            out.append("MPP")
            emit_tails()
        else:
            out.extend(render_branch(br2))
            emit_tails()
        return out
    if any(b[0]["main"][2] and b[0]["main"][2][0] == 0x61 for b in brs):
        layers = _layer_split(brs)
        if all(l[0] for l in layers):
            first = True
            closed = False
            for li, (o, inn) in enumerate(layers):
                for bi, b in enumerate(o):
                    if first:
                        pre, br2 = split_common(b)
                        out.extend(pre)
                        out.append("MPS")
                        out.extend(render_branch(br2))
                        first = False
                    else:
                        if (not tail_after and li == len(layers) - 1
                                and bi == len(o) - 1):
                            out.append("MPP")
                            closed = True
                        elif not (bi == 0 and li > 0 and layers[li - 1][1]):
                            out.append("MRD")
                        out.extend(render_branch(b))
                if inn:
                    out.append("MPS")
                    for k, b in enumerate(inn):
                        if k > 0:
                            out.append("MRD")
                        out.extend(render_branch(b))
                    out.append("MPP")
            emit_tails()
            if not closed:
                out.append("MPP")
            return out
    # 重写：按 WPLSoft 的「腿」模型——所有 leg 都占位置，空 leg 只被打 MRD/MPP 不产指令
    if STRAT2.get("legs_all"):
        legs = list(seg)
        N2 = len(legs)
        for k, br in enumerate(legs):
            if k == 0:
                pre, br2 = split_common(br)
                out.extend(pre)
                out.append("MPS")
                out.extend(render_branch(br2))
            elif k == N2 - 1:
                out.append("MPP")
                out.extend(render_branch(br))
            else:
                out.append("MRD")
                out.extend(render_branch(br))
        emit_tails()
        return out
    if STRAT2.get("layered") and brs and all(b[0]["main"][2] for b in brs):
        cur = 1
        out.append("MPS")
        for br in brs:
            g = br[0]["main"][2][2]
            target = max(0, g - 1)
            while cur < target:
                out.append("MPS")
                cur += 1
            while cur > target:
                out.append("MPP")
                cur -= 1
            out.extend(render_branch(br))
        while cur > 0:
            out.append("MPP")
            cur -= 1
        emit_tails()
        return out
    if STRAT2.get("action_stack"):
        acted = [i for i, b in enumerate(brs) if _has_action(b)]
        if not acted:
            for b in brs:
                out.extend(render_branch(b))
            emit_tails()
            return out
        first, last = acted[0], acted[-1]
        for k, br in enumerate(brs):
            if first == last:
                if k == first:
                    pre, br2 = split_common(br)
                    out.extend(pre)
                    out.append("MPS")
                    out.extend(render_branch(br2))
                    out.append("MPP")
                else:
                    out.extend(render_branch(br))
                continue
            if k == first:
                pre, br2 = split_common(br)
                out.extend(pre)
                out.append("MPS")
                out.extend(render_branch(br2))
            elif k == last:
                out.append("MPP")
                out.extend(render_branch(br))
            else:
                out.append("MRD")
                out.extend(render_branch(br))
        emit_tails()
        return out
    for k, br in enumerate(brs):
        if k == 0:
            pre, br2 = split_common(br)
            out.extend(pre)
            out.append("MPS")
            out.extend(render_branch(br2))
        elif k == N - 1 and _lastmpp(tail_after, tails):
            out.append("MPP")
            out.extend(render_branch(br))
        else:
            out.append("MRD")
            out.extend(render_branch(br))
    emit_tails()
    if not _lastmpp(tail_after, tails) and (tail_after or tails):
        out.append("MPP")
    return out


def parse_rows(data, start):
    heads = [m.start() for m in re.finditer(rb"\x12\x05\xe8\x03\x00", data)]
    heads = [h for h in heads if (h - start) % 60 == 0]
    rows = []
    for hi, h in enumerate(heads):
        end = heads[hi + 1] if hi + 1 < len(heads) else len(data)
        if hi + 1 >= len(heads):
            ff = data.find(b"\xff" * 200, h)
            if ff > h:
                end = ff
        ncol = (end - h) // 60
        cols = []
        pending = []
        for c in range(ncol):
            p = h + c * 60
            cells = [data[p + k * 5:p + k * 5 + 5] for k in range(CELLS)]
            head = None
            dc0 = decode_cell(cells[0])
            if c == 0:
                if dc0["kind"] == "CONTACT":
                    cells = [b"\x00\x00\x00\x00\x00"] + cells[1:]
            elif dc0["kind"] == "CONTACT":
                par = False
                for kk in (2, 3, 4):
                    dk = decode_cell(cells[kk])
                    if dk["kind"] == "MARK" and dk["m"] in (0x0B, 0x57, 0x5A, 0x68):
                        par = True
                        break
                if not par:
                    head = ("BLK", dc0)
                    cells = [b"\x00\x00\x00\x00\x00"] + cells[1:]
            conds, outs, mark, pending = parse_col(cells, head, pending)
            if c > 0 and dc0["kind"] == "CMP" and conds and conds[0][0] == "CMP":
                conds[0] = ("HEAD", conds[0])
            cols.append((conds, outs, mark))
        rows.append((h, cols))
    return rows


if __name__ == "__main__":
    path, csvp = sys.argv[1], sys.argv[2]
    data = D.read_bytes(path)
    start = int(sys.argv[3], 0) if len(sys.argv) > 3 else 16498
    rows = parse_rows(data, start)
    truth = []
    with io.open(csvp, encoding="utf-8-sig") as f:
        cur = None
        for r in csv.reader(f):
            r = [c.strip() for c in r if c.strip()]
            if len(r) >= 2 and re.fullmatch(r"\d{6}", r[0]):
                if r[1] == "LD" and r[2:3] == ["M1000"]:
                    cur = []
                    truth.append(cur)
                if cur is not None:
                    cur.append(("%s %s" % (r[1], " ".join(r[2:]))).strip())
    same = 0
    n = min(len(rows), len(truth))
    for i in range(n):
        got = render_row(rows[i][1])
        exp = [t for t in truth[i] if t != "LD M1000"]
        if got == exp:
            same += 1
    print("v5 完全一致 %d/%d" % (same, n))
