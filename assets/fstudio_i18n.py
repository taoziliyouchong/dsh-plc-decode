# -*- coding: utf-8 -*-
r"""FStudio / Flexem 触摸屏多语言：扫元件文本 → 出中英对照表 → 出可导入文本库表。

四个子命令：
  scan  <工程目录或.fsprj> <out.json>                 只扫描，出 JSON
  pair  <scan.json> <对照表.xlsx> [词典.py]             出「中文|英文|画面|原英文槽」对照表
  make  <工程目录或.fsprj> <输出目录> [词典.py]          一步到位：扫描 + 对照表 + 可导入表
  retag <已导出的TextLib表> <输出.xlsx> <词典> [语种键] [最少状态数]
                                                       换语种列：把导出表的第三语种列
                                                       （如韩语）整列换成目标语种（如巴葡），
                                                       其余列原样保留 → 可直接导回文本库
                                                       给「最少状态数」（如 2）时，状态不够的
                                                       条目按首行补足状态行（Guid 留空、Status 递增、
                                                       文字与首行同）

可导入表列名与 FStudio 导出的 TextLib 表逐字符一致：
  Guid | Name | Status | 1-Chinese (Simplified, PRC)-2052 | 2-English (United States)-1033
给了第三语种词典（.py 的 ELEMENT_KO/ELEMENT_PT/LONG_*，或 .json 的 "ko"/"pt"）时，末尾再加一列，
列名按语种键取自 LANG_HEADS：
  3-Korean (Korea)-1042 / 3-Portuguese (Brazil)-1046 / 3-Portuguese (Portugal)-2070 / 3-Russian (Russia)-1049 …
"""
import collections
import json
import os
import re
import sys
import uuid
import xml.etree.ElementTree as ET

NS = "{http://schemas.flexem.com/fs/model/1}"
CJK = re.compile(r"[\u4e00-\u9fff]")
HEAD_ZH = "1-Chinese (Simplified, PRC)-2052"
HEAD_EN = "2-English (United States)-1033"
HEAD_KO = "3-Korean (Korea)-1042"

# 第三语种：词典键 → 导入表列名（列名必须与 FStudio 导出的 TextLib 表逐字符一致）
LANG_HEADS = {
    "ko": "3-Korean (Korea)-1042",
    "pt": "3-Portuguese (Brazil)-1046",
    "pt-pt": "3-Portuguese (Portugal)-2070",
    "ru": "3-Russian (Russia)-1049",
    "es": "3-Spanish (Spain)-3082",
    "vi": "3-Vietnamese (Vietnam)-1066",
    "th": "3-Thai (Thailand)-1054",
    "ar": "3-Arabic (Saudi Arabia)-1025",
}
# 词典里找第三语种的顺序（都给了就按这个优先级取第一个）
LANG_ORDER = ["pt", "pt-pt", "ko", "ru", "es", "vi", "th", "ar"]
_LANG_ATTRS = {"pt-pt": "PT_PT", "pt": "PT", "ko": "KO", "ru": "RU", "es": "ES",
               "vi": "VI", "th": "TH", "ar": "AR"}


# ────────────────────────── 工程解析 ──────────────────────────

def project_dir(p):
    """传入 .fsprj 或工程目录，返回工程目录。"""
    if p.lower().endswith(".fsprj"):
        return os.path.dirname(os.path.abspath(p))
    return os.path.abspath(p)


def scan_elements(proj):
    """静态文本元件：每个元件按语种槽取 LabelContent（1 中文 / 2 英文 / 3 俄语）。"""
    frame = os.path.join(project_dir(proj), "HMI", "Frame")
    out = []
    for dirpath, _dirs, files in os.walk(frame):
        for fn in files:
            if not fn.lower().endswith(".wcfg"):
                continue
            try:
                root = ET.parse(os.path.join(dirpath, fn)).getroot()
            except Exception:
                continue
            win = (root.findtext(NS + "Name") or "").strip()
            for g in root.iter(NS + "GraphicsBase"):
                etype = g.get("{http://www.w3.org/2001/XMLSchema-instance}type") or ""
                labs = collect_labels(g)
                if not labs:
                    continue
                out.append({"win": win, "file": fn, "type": etype,
                            "gid": g.findtext(NS + "UniqueId") or "",
                            "tlib": g.findtext(NS + "NormalInfo/" + NS + "TextLibId") or "",
                            "labels": labs})
    return out


def collect_labels(g):
    """一个元件里所有按语种分槽的文字。

    三条路都要收（2026-09-22 修两轮：
      ① 原先只收静态文本，漏掉按钮/开关的一整套标签；
      ② 第二版只从 TagStatus 往下找，漏掉直接挂在 Statuses/Items 下的那种）：
      ① 静态文本：StaticTextContentInfo 里的 LanguageSN + LabelContent
      ② 按钮/开关/指示灯：凡 TagStatusLanguage（不管父层是 TagStatus 还是 Statuses/Items）
      ③ 少数元件：TitleSettingLanguage
    返回 [{lang, text, status}]，lang 为语种号（1 中文 / 2 英文 / 3 俄语）。
    """
    labs = []
    for ci in g.iter(NS + "StaticTextContentInfo"):
        sn = ci.findtext(NS + "LanguageSN")
        tx = (ci.findtext(NS + "LabelContent") or "").strip()
        if sn is not None:
            labs.append({"lang": sn, "text": tx, "status": ""})
    # 不依赖父层：凡是 TagStatusLanguage 都收（父层可能是 TagStatus，也可能直接是 Statuses/Items）
    for tl in g.iter(NS + "TagStatusLanguage"):
        lid = tl.findtext(NS + "LanguageId")
        tx = (tl.findtext(NS + "Text") or "").strip()
        if lid is not None:
            labs.append({"lang": lid, "text": tx, "status": ""})
    # 少数元件把标签放在 TitleSettingContentInfos 下
    for tl in g.iter(NS + "TitleSettingLanguage"):
        lid = tl.findtext(NS + "LanguageId")
        tx = (tl.findtext(NS + "Text") or "").strip()
        if lid is not None:
            labs.append({"lang": lid, "text": tx, "status": ""})
    return labs


def scan_library(proj):
    """文本库现有条目（Global\\TextLibConfigInfo.cfg）。"""
    cfg = os.path.join(project_dir(proj), "Global", "TextLibConfigInfo.cfg")
    if not os.path.exists(cfg):
        return []
    root = ET.parse(cfg).getroot()
    items = []
    for it in root.findall(NS + "TextItemInfos/" + NS + "TextItemInfo"):
        langs = collections.defaultdict(set)
        for st in it.findall(NS + "TextStatusInfos/" + NS + "TextStatusInfo"):
            for lt in st.findall(NS + "LanguageTextInfos/" + NS + "LanguageTextInfo"):
                sn = lt.findtext(NS + "LanguageSN")
                tx = (lt.findtext(NS + "LanguageText") or "").strip()
                if tx and sn:
                    langs[sn].add(tx)
        items.append({"name": it.findtext(NS + "Name"),
                      "langs": {k: sorted(v) for k, v in langs.items()}})
    return items


def texts_of(e, lang):
    """某个元件里指定语种的全部文字（去重，保序）。"""
    out = []
    for l in e.get("labels", []):
        if str(l.get("lang")) == str(lang):
            t = (l.get("text") or "").strip()
            if t and t not in out:
                out.append(t)
    return out


def build_pairs(elems):
    """元件里中文标签 ↔ 英文标签 的对应（原工程自带的译文，作为译法参考）。"""
    pair = collections.defaultdict(collections.Counter)
    for e in elems:
        zs, es = texts_of(e, 1), texts_of(e, 2)
        for zh, en in zip(zs, es):
            if zh and en:
                pair[zh][en] += 1
    return {k: v.most_common(1)[0][0] for k, v in pair.items()}


# ────────────────────────── 词典 ──────────────────────────

def load_dict(path, lang=None):
    """词典，两种写法：
      · 旧（单语）：{中文: 英文} 的 json，或含 ELEMENT_EN/LONG_EN 的 python
      · 多语：json {"en": {...}, "pt": {...}}，或 python 里再加 ELEMENT_PT/LONG_PT
    返回 (英表, lookup, rename, 第三语种表, 第三语种键)；rename 是项目级「中文改写」表。
    lang 显式给了就用它（平表也当该语种）；没给时按 LANG_ORDER 在词典里找第一个第三语种。"""
    if not path or not os.path.exists(path):
        return {}, None, {}, {}, ""
    if path.endswith(".json"):
        data = json.load(open(path, encoding="utf-8"))
        if isinstance(data, dict) and any(isinstance(v, dict) for v in data.values()):
            en = data.get("en") or {}
            key = lang if lang in data else next((k for k in LANG_ORDER if k in data), "")
            return en, None, {}, (data.get(key) or {}) if key else {}, key
        # 平表：给了 lang 就当该语种，否则当英文表
        if lang:
            return {}, None, {}, data, lang
        return data, None, {}, {}, ""
    import importlib.util
    spec = importlib.util.spec_from_file_location("i18n_dict", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    table = {}
    for nm in ("ELEMENT_EN", "LONG_EN"):
        table.update(getattr(mod, nm, None) or {})
    key = lang if lang else next(
        (k for k in LANG_ORDER if getattr(mod, "ELEMENT_" + _LANG_ATTRS[k], None)), "")
    third = {}
    if key:
        for nm in ("ELEMENT_" + _LANG_ATTRS[key], "LONG_" + _LANG_ATTRS[key]):
            third.update(getattr(mod, nm, None) or {})
    return table, getattr(mod, "lookup", None), (getattr(mod, "RENAME", None) or {}), third, key


def apply_rename(text, rename):
    """按项目词典里的 RENAME 把中文旧写法换成规范写法（如 常按→长按）。"""
    if not rename or not text:
        return text
    for old, new in rename.items():
        if old in text:
            text = text.replace(old, new)
    return text


def translate(text, table, lookup):
    if text in table:
        return table[text]
    key = (text or "").replace("\r\n", "\n")
    if key in table:
        return table[key]
    if lookup:
        return lookup(text) or ""
    return ""


# ────────────────────────── 输出 ──────────────────────────

# 对照表里第三语种列的中文标题
LANG_LABELS = {"ko": "韩文", "pt": "葡文(巴)", "pt-pt": "葡文(葡)", "ru": "俄文",
               "es": "西文", "vi": "越文", "th": "泰文", "ar": "阿文"}


def write_pair_table(rows, out_xlsx, ko=None, lang="ko"):
    """对照表：序号|中文|英文|(第三语种)|出现次数|所在画面|元件里原来的英文槽|英文来源。
    ko（{中文: 第三语种}）非空时多一列，缺的标黄；lang 决定列标题。"""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter
    has_ko = bool(ko)
    head = ["序号", "中文", "英文"] + ([LANG_LABELS.get(lang, lang)] if has_ko else []) + \
           ["出现次数", "所在画面", "元件里原来的英文槽", "英文来源"]
    ncol = len(head)
    i_en, i_ko, i_slot, i_src = 3, (4 if has_ko else 0), ncol - 2, ncol
    wb = Workbook()
    ws = wb.active
    ws.title = "对照表"
    thin = Side(style="thin", color="BFBFBF")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    hf = PatternFill("solid", fgColor="1F4E79")
    hfont = Font(color="FFFFFF", bold=True)
    yellow = PatternFill("solid", fgColor="FFF2CC")
    ws.append(head)
    for c in range(1, ncol + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border = hf, hfont, border
        cell.alignment = Alignment(horizontal="center", vertical="center")
    wrap = {2, 3, i_slot, i_src} | ({i_ko} if has_ko else set())
    for idx, (zh, en, n, wins, slot, src_note) in enumerate(rows, 1):
        vals = [idx, zh, en] + ([ko.get(zh, "")] if has_ko else []) + [n, wins, slot, src_note]
        ws.append(vals)
        r = ws.max_row
        for c in range(1, ncol + 1):
            ws.cell(row=r, column=c).border = border
            ws.cell(row=r, column=c).alignment = Alignment(vertical="top", wrap_text=(c in wrap))
        if not en:
            ws.cell(row=r, column=i_en).fill = yellow
            ws.cell(row=r, column=i_src).fill = yellow
        if has_ko and not ko.get(zh, ""):
            ws.cell(row=r, column=i_ko).fill = yellow
    widths = [6, 34, 44] + ([36] if has_ko else []) + [10, 34, 34, 18]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:%s%d" % (get_column_letter(ncol), ws.max_row)
    wb.save(out_xlsx)


def write_import_table(rows, out_xlsx, sheet="TextLib", ko=None, lang="ko"):
    """rows: (中文, 采用的英文, 次数, 画面, 原英文槽, 是否新补/替换)；ko: {中文: 第三语种}
    FStudio 可导入格式：每行一个条目、Guid 唯一、Status=0。ko 非空时带第三语种列（列名按 lang）。"""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter
    has_ko = bool(ko)
    head = ["Guid", "Name", "Status", HEAD_ZH, HEAD_EN] + \
           ([LANG_HEADS.get(lang, HEAD_KO)] if has_ko else [])
    ncol = len(head)
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    thin = Side(style="thin", color="BFBFBF")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    hf = PatternFill("solid", fgColor="1F4E79")
    hfont = Font(color="FFFFFF", bold=True)
    yellow = PatternFill("solid", fgColor="FFF2CC")
    ws.append(head)
    for c in range(1, ncol + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border = hf, hfont, border
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for row in rows:
        zh, en = row[0], row[1]
        name = re.sub(r"\s+", " ", zh.replace("\r\n", " ").replace("\n", " ")).strip()[:50] or "text"
        vals = [str(uuid.uuid4()), name, 0, zh, en] + ([ko.get(zh, "")] if has_ko else [])
        ws.append(vals)
        r = ws.max_row
        for c in range(1, ncol + 1):
            ws.cell(row=r, column=c).border = border
            ws.cell(row=r, column=c).alignment = Alignment(vertical="top", wrap_text=(c in (2, 4, 5, 6)))
        ws.cell(row=r, column=3).number_format = "0"
        if not en:
            ws.cell(row=r, column=5).fill = yellow
        if has_ko and not ko.get(zh, ""):
            ws.cell(row=r, column=6).fill = yellow
    widths = [38, 40, 8, 46, 52] + ([40] if has_ko else [])
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    wb.save(out_xlsx)


# ────────────────────────── 主流程 ──────────────────────────

def aggregate(elems, rename=None):
    """把元件文字聚成 {中文: {n, wins, slot}}；slot 记元件里原有的英文（若有）。
    rename：项目级中文改写（旧写法→规范写法），聚合前先套用。"""
    agg = collections.OrderedDict()
    for e in elems:
        zs = [apply_rename(t, rename) for t in texts_of(e, 1) if CJK.search(t)]
        es = texts_of(e, 2)
        if not zs:
            continue
        # 中文与英文在元件里按顺序成组：第 i 个中文对应第 i 个英文
        for i, zh in enumerate(zs):
            a = agg.setdefault(zh, {"n": 0, "wins": [], "slot": ""})
            a["n"] += 1
            if e["win"] not in a["wins"]:
                a["wins"].append(e["win"])
            if not a["slot"] and i < len(es):
                a["slot"] = es[i]
    return agg


# 判定为“原件英文有明显失误、必须换成定版”的条目（其余一律沿用原件英文）
FORCE_FIX = {
    "标记取料位置", "标记放料位置", "标记取料过顶位置", "标记放料过顶位置",
    "标记放料吹气位置", "标记回零位置", "标记待料位置",          # 原为 back to/zero，词不达意
    "点进", "点退", "点动",                                      # 原为 point/feed
    "回零", "正向回零", "反向回零",                              # 原为 back to/zero / point/feed
    "返回", "上一页", "下一页",                                  # 大小写/缩写统一
    "吸料真空", "吸料真空检测",                                  # 原件填的是数字 8
    "拨号",                                                      # Dail 拼写错
    "保存绝对值", "非保存绝对值",                                # 原为 point/feed
    "操作界面",                                                  # operation/interface 不是行业说法
    "加热开", "加热关",                                          # heat on/off → Heater on/off
}


def merge_rows(agg, table, lookup):
    """定译口径（2026-09-22 用户最终定：全用定版译文）。
       · 有词典译文 → 一律用定版（覆盖元件里原有的英文）；
       · 词典没有 → 退回元件原有英文；再没有 → 空（标黄）。
    返回 (zh, 采用的英文, 次数, 画面, 原英文槽, 来源标记)。"""
    rows = []
    for zh, a in sorted(agg.items(), key=lambda kv: (-kv[1]["n"], kv[0])):
        # 不做任何"同义/错别字合并"：元件上怎么写就怎么出条目，
        # 否则元件在文本库里会找不到对应条目（2026-09-22 踩过：档箱/挡箱 两条只出一条）
        slot = (a.get("slot") or "").strip()
        mine = translate(zh, table, lookup)
        # 防呆：译文里若混着汉字，等于没译（如“班组计数 on”），一律作废，让缺译清单暴露出来
        if mine and CJK.search(mine):
            mine = ""
        # 兜底：原件英文槽若本身混着汉字，同样不算译文
        if slot and CJK.search(slot):
            slot = ""
        if mine:
            en = mine
            src_note = "定版（覆盖原件英文）" if slot else "定版（原件无英文）"
        else:
            en = slot
            src_note = "退用原件英文" if slot else "缺译文"
        rows.append((zh, en, a["n"], "、".join(a["wins"]), slot, src_note))
    return rows


def collect(proj, table, lookup, rename=None):
    elems = scan_elements(proj)
    return elems, merge_rows(aggregate(elems, rename), table, lookup)


def cmd_scan(args):
    proj, out = args[0], args[1]
    data = {"elems": scan_elements(proj), "lib": scan_library(proj)}
    data["pairs"] = build_pairs(data["elems"])
    json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print("元件=%d 文本库条目=%d -> %s" % (len(data["elems"]), len(data["lib"]), out))


def cmd_pair(args):
    scan_json, out = args[0], args[1]
    d = json.load(open(scan_json, encoding="utf-8"))
    table, lookup, rename, third, lang = load_dict(args[2] if len(args) > 2 else None)
    elems = d["elems"]
    agg = aggregate(elems, rename)
    rows = merge_rows(agg, table, lookup)
    write_pair_table(rows, out, third, lang or "ko")
    noen = [r for r in rows if not r[1]]
    nothird = [r for r in rows if third and not third.get(r[0])]
    print("对照表=%d 条（无英文 %d，无第三语种 %d）-> %s" % (len(rows), len(noen), len(nothird), out))
    for r in noen[:20]:
        print("   缺英文:", r[0][:40])


def cmd_make(args):
    proj, outdir = args[0], args[1]
    dpath = args[2] if len(args) > 2 else None
    os.makedirs(outdir, exist_ok=True)
    table, lookup, rename, third, lang = load_dict(dpath)
    elems, rows = collect(proj, table, lookup, rename)
    pair_x = os.path.join(outdir, "元件多语言对照表.xlsx")
    imp_x = os.path.join(outdir, "文本库导入表.xlsx")
    write_pair_table(rows, pair_x, third, lang or "ko")
    write_import_table(rows, imp_x, ko=third, lang=lang or "ko")
    noen = [r for r in rows if not r[1]]
    nothird = [r for r in rows if third and not third.get(r[0])]
    print("元件=%d；对照表=%d 条；无英文=%d；无第三语种=%d；语种=%s" % (
        len(elems), len(rows), len(noen), len(nothird),
        "中/英/%s" % (LANG_LABELS.get(lang, lang)) if third else "中/英"))
    print("对照表 ->", pair_x)
    print("导入表 ->", imp_x)
    if noen:
        print("--- 这些还没英文，补进词典后重跑 ---")
        for r in noen[:30]:
            print("   ", r[0][:50])
    if nothird:
        print("--- 这些还没第三语种译文，补进词典后重跑 ---")
        for r in nothird[:30]:
            print("   ", r[0][:50])


# ────────────────────────── 换语种列（已导出的 TextLib 表）──────────────────────────

def read_lib_table(path):
    """读 FStudio 导出的 TextLib 表（.xls 走 xlrd，.xlsx 走 openpyxl）。
    返回 (表名, 表头, 行列表)；数字单元格转整数，文本**原样保留**（软件导出的 Name 列常带首尾空格，
    strip 掉会让前几列与源表对不上、失去「原样」保证）。
    注：表头与中文列的空值判断用 .strip() 只看空不空，落盘的值不动。"""
    if path.lower().endswith(".xls"):
        import xlrd
        b = xlrd.open_workbook(path)
        sh = b.sheet_by_index(0)
        head = [str(sh.cell_value(0, c)).strip() for c in range(sh.ncols)]
        rows = []
        for r in range(1, sh.nrows):
            vals = []
            for c in range(sh.ncols):
                v = sh.cell_value(r, c)
                if isinstance(v, float) and v == int(v):
                    v = int(v)
                vals.append("" if v is None else (v if isinstance(v, int) else str(v)))
            if any(str(x).strip() for x in vals):
                rows.append(vals)
        return sh.name, head, rows
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    head = [(str(c.value).strip() if c.value is not None else "") for c in ws[1]]
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        vals = []
        for v in r:
            if v is None:
                vals.append("")
            elif isinstance(v, float) and v == int(v):
                vals.append(int(v))
            elif isinstance(v, int):
                vals.append(v)
            else:
                vals.append(str(v))
        if any(str(x).strip() for x in vals):
            rows.append(vals)
    return ws.title, head, rows


def write_lib_table(sheet, head, rows, out_xlsx):
    """按 FStudio 导出的样子写回：表头原样、Status 走数字、其余列文本。
    输出按扩展名走：.xls（需 xlwt）或 .xlsx（openpyxl）。"""
    if out_xlsx.lower().endswith(".xls"):
        import xlwt
        wb = xlwt.Workbook(encoding="utf-8")
        ws = wb.add_sheet(sheet or "TextLib")
        for c, h in enumerate(head):
            ws.write(0, c, h)
        for r, row in enumerate(rows, 1):
            for c, v in enumerate(row):
                ws.write(r, c, v if isinstance(v, int) else ("" if v is None else str(v)))
        wb.save(out_xlsx)
        return
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = sheet or "TextLib"
    thin = Side(style="thin", color="BFBFBF")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    hf = PatternFill("solid", fgColor="1F4E79")
    hfont = Font(color="FFFFFF", bold=True)
    ws.append(head)
    for c in range(1, len(head) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border = hf, hfont, border
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for row in rows:
        ws.append(row)
        r = ws.max_row
        for c in range(1, len(head) + 1):
            cell = ws.cell(row=r, column=c)
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=(c != 3))
        ws.cell(row=r, column=3).number_format = "0"
    widths = [38, 40, 8, 46, 52, 46]
    for i, w in enumerate(widths[:len(head)], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    wb.save(out_xlsx)


def expand_status(rows, min_status):
    """把状态数不足 min_status 的条目补足：新增行 Guid 留空、Status 递增、各语种文字与**首行相同**。

    判组按 FStudio 导出结构：首行带 Guid、后续状态行 Guid 为空。
    （工程里成对词的条目本来就是两个状态各写各的字；单状态条目补的第二个状态就与首行同字，
    软件导出的表里也是这么写的，不自己造词。）
    返回 (新行列表, 补了几行)。"""
    if not min_status or min_status < 2:
        return rows, 0
    out, added, i = [], 0, 0
    while i < len(rows):
        head = rows[i]
        grp = [head]
        j = i + 1
        while j < len(rows) and not str(rows[j][0]).strip():
            grp.append(rows[j])
            j += 1
        out.extend(grp)
        for k in range(max(0, min_status - len(grp))):
            new = list(head)
            new[0] = ""
            new[2] = len(grp) + k
            out.append(new)
            added += 1
        i = j
    return out, added


def cmd_retag(args):
    """retag <已导出TextLib表> <输出.xlsx> <词典> [语种键] [最少状态数]
    第三语种列整列换成词典给的语种，行序/Guid/Status/中英文列原样 → 可直接导回文本库。
    给了「最少状态数」（如 2）时，状态不够的条目按其首行补足状态行。"""
    src, out = args[0], args[1]
    dpath = args[2] if len(args) > 2 else None
    lang_want = args[3] if len(args) > 3 else None
    min_status = int(args[4]) if len(args) > 4 and str(args[4]).strip().isdigit() else 0
    table, lookup, _rename, third, lang = load_dict(dpath, lang_want)
    lang = lang_want or lang
    if not third:
        raise SystemExit("词典里没找到第三语种译文（.json 写 \"pt\"/\"ko\"，.py 写 ELEMENT_PT/ELEMENT_KO）；"
                         "语种键：%s" % (lang_want or "(未指定)"))
    head_new = LANG_HEADS.get(lang)
    if not head_new:
        raise SystemExit("未知语种键 %s（可选: %s）" % (lang, "、".join(LANG_HEADS)))
    sheet, head, rows = read_lib_table(src)
    rows, added = expand_status(rows, min_status)
    # 列位置：0 Guid / 1 Name / 2 Status / 3 中文 / 4 第二语种 / 5 第三语种
    out_head = list(head[:5]) + [head_new]
    out_rows, miss = [], []
    for r in rows:
        zh = str(r[3]).strip() if len(r) > 3 else ""
        txt = third.get(zh, "")
        if not txt and lookup:
            txt = lookup(zh) or ""
        if not txt:
            miss.append(zh)
        out_rows.append(list(r[:5]) + [txt])
    if miss:
        for t in list(dict.fromkeys(miss))[:30]:
            print("   缺:", repr(t[:40]))
        raise SystemExit("有 %d 行没译文，未输出（先补词典）" % len(miss))
    write_lib_table(sheet, out_head, out_rows, out)
    print("源表: %s（%d 行 × %d 列，表名 %s）" % (src, len(rows) - added, len(head), sheet))
    print("目标语种: %s -> 列名 %s" % (lang, head_new))
    if min_status:
        print("补状态行: 最少 %d 个状态，本次补了 %d 行" % (min_status, added))
    print("输出行数 %d；缺译 0" % len(out_rows))
    print("输出 ->", out)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "scan":
        cmd_scan(args)
    elif cmd == "pair":
        cmd_pair(args)
    elif cmd == "make":
        cmd_make(args)
    elif cmd == "retag":
        cmd_retag(args)
    else:
        raise SystemExit("未知子命令: %s" % cmd)


if __name__ == "__main__":
    main()
