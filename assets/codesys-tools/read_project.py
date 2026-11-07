# -*- coding: utf-8 -*-
"""
read_project.py — 读取 CoDeSys V3.5 / LeadSysStudio 工程文件 (.project) 的内容。

用法:
    python read_project.py <工程文件.project> [-o 输出目录]

功能:
  1. 解包 .project (ZIP)
  2. 解码共享字符串表 __shared_data_storage_string_table__.auxiliary
     (varint 总数 + [id varint][len varint][UTF-8 字节] 记录, id 0..N 顺序)
  3. 解析每个 {GUID}.object 的内容引用, 按序恢复 POU/GVL/DUT 源码
  4. 导出: 工程内容报告.md + pous/<名称>.txt + 对象表 + 全部字符串

格式要点 (逆向自 3.5.15.40 内核工程, 已验证零剩余消费):
  * .project 是 ZIP; 内部 {GUID}.meta/.object/.auxiliary
  * 所有文件: 16 字节头 (02 20 09 28 + 12×00) + 4 字节 LE 长度 + 负载
  * 负载节点: 0x0f <varint 类型> <内容>
      - 类型 0x03: 内联 UTF-16 字符串 (如 ProjectRoot 的 IArchivable XML)
      - 类型 0x3F: 单个 2 字节 LE 字符串引用
      - 记录容器 (POU/GVL/DUT 等): 若干 section, 每个 =
          配置 varint (最后一个=记录数) + 0x0f 0x20 + 记录×N
          记录 = <A varint><补齐=9-实际A字节数><B varint><0x20>
          最后一条记录可无 0x20 (直接接下一 section 配置)
          B = 内容字符串引用 (按序)
      - 设备对象 (类型 0x18/0x4D 等): 另类结构, 回退为"提取全部引用"
"""
import io
import os
import re
import struct
import sys
import zipfile

if __name__ == "__main__" and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MAGIC = b"\x02\x20\x09\x28"


def read_varint(b, i):
    v = 0
    sh = 0
    while True:
        x = b[i]
        i += 1
        v |= (x & 0x7F) << sh
        if not (x & 0x80):
            return v, i
        sh += 7
        if sh > 70:
            raise ValueError("varint too long")


def load_strings(path):
    with open(path, "rb") as f:
        data = f.read()
    i = 0
    count, i = read_varint(data, i)
    out = []
    for _ in range(count):
        _, i = read_varint(data, i)
        slen, i = read_varint(data, i)
        out.append(data[i:i + slen])
        i += slen
    return out


def decode(b):
    return b.decode("utf-8", "replace")


def load_payload(path):
    data = open(path, "rb").read()
    ln = struct.unpack("<I", data[16:20])[0]
    return data[20:20 + ln]


def is_inline_string(payload):
    """类型 0x03 内联 UTF-16 字符串 (如 IArchivable XML)。"""
    if not payload or payload[0] != 0x0F:
        return None
    try:
        t, i = read_varint(payload, 1)
        if t != 0x03:
            return None
        ln, i = read_varint(payload, i)
        if i < len(payload) and payload[i] == 0x02:
            i += 1
        raw = payload[i:i + ln]
        if raw[:2] == b"\xff\xfe":
            return raw[2:].decode("utf-16-le", "replace")
        return raw.decode("utf-16-le", "replace")
    except Exception:
        return None


def parse_record_container(payload):
    """
    解析记录容器。返回 (sections, leftover, err)。
    section = (config, [(A, B), ...]); B = 内容字符串引用。
    语法: [A varint][补齐 9-实际A字节][B varint][0x20]; 末条可无 0x20。
    """
    p = payload
    if not p or p[0] != 0x0F:
        return [], p, "not 0x0f"
    try:
        t, i = read_varint(p, 1)
    except Exception:
        return [], p, "bad type"
    if t in (0x03, 0x3F):
        return [], p, "leaf type"
    sections = []
    while i < len(p):
        config = []
        while i < len(p):
            if p[i] == 0x0F:
                # 0x0f 可能是段标记 (0f 20), 也可能是配置 varint 值 15 (如记录数 N=15)。
                # 判定: 后一字节是 0x20 → 段标记; 否则当作配置 varint 15 继续读。
                if i + 1 < len(p) and p[i + 1] == 0x20:
                    break
            try:
                v, i = read_varint(p, i)
            except Exception:
                return sections, p[i:], "bad config varint"
            config.append(v)
        if i >= len(p):
            break
        if i + 1 >= len(p) or p[i + 1] != 0x20:
            return sections, p[i:], f"bad section marker @{i}"
        i += 2
        n = config[-1]
        recs = []
        for r in range(n):
            if i >= len(p):
                return sections, p[i:], f"ran out rec{r}"
            a0 = i
            try:
                A, i = read_varint(p, i)
            except Exception:
                return sections, p[i:], f"bad A rec{r}"
            alen = i - a0
            pad = 9 - alen
            if pad < 0 or i + pad > len(p):
                return sections, p[i:], f"pad overflow rec{r} A={A}"
            i += pad
            try:
                B, i = read_varint(p, i)
            except Exception:
                return sections, p[i:], f"bad B rec{r}"
            if i >= len(p):
                return sections, p[i:], f"eof rec{r}"
            if p[i] == 0x20:
                i += 1
            elif r != n - 1:
                return sections, p[i:], f"no term rec{r} A={A} B={B} byte={p[i]:02x}"
            recs.append((A, B))
        sections.append((config, recs))
    return sections, b"", None


def parse_task_config(payload, strings):
    """
    任务对象 (节点类型 0x2a): 返回 (参数列表, 挂载程序名列表) 或 None。

    结构 (逆向自 3.5.15.40 内核, 已验证 MainTask):
        0f 2a <配置 varints…> 0f 29 <调用列表>
    配置区引用: 任务类型(Cyclic)、优先级(1)、周期(t#…ms)、看门狗等字符串。
    调用列表每项: <程序名引用> <17 空串> <41 'True'>，按顺序重复 = 挂载顺序。
    """
    if not payload or payload[0] != 0x0F:
        return None
    t, i = read_varint(payload, 1)
    if t != 0x2A:
        return None
    params = []
    while i < len(payload) and payload[i] != 0x0F:
        v, i = read_varint(payload, i)
        if v < len(strings):
            s = decode(strings[v]).strip()
            if s and not (len(s) == 36 and "-" in s):
                params.append(s)
    calls = []
    if i < len(payload) and payload[i] == 0x0F:
        i += 1  # 跳过 0x0F 节点标记 (0x0F 本身会被误读成 varint 15)
    while i < len(payload):
        try:
            v, i = read_varint(payload, i)
        except Exception:
            break
        if v == 17 or v >= len(strings):
            continue
        s = decode(strings[v]).strip()
        if not s or (len(s) == 36 and "-" in s):
            continue
        if s in ("True", "False", "ms"):
            continue
        if s not in calls:
            calls.append(s)
    return params, calls


ZERO_GUID = "00000000-0000-0000-0000-000000000000"
META_PARENT_MARK = 1468   # 'd9b2b2cc-...' 系统 GUID, 标记"文件夹父节点"字段
APP_REF = 57              # 'ff8d0207-...' Application (Plc Logic)


def parse_meta(meta, self_guid_lower, strings):
    """
    解析 .meta 负载 -> (对象名, 父GUID小写|None, 父ref)。

    逆向规律 (CoDeSys 3.5.15.40 内核, 45 对象全验证):
      * 普通 POU (PROGRAM/FB/DUT/GVL/文件夹) 结构:
         0f 19 <self> 57(Application) <name> ... [bc0b(1468) <文件夹父>] <时间戳>
         - 1468 段 = 文件夹父节点 (有则在该文件夹下)
         - 无 1468 段 = 直接挂 Application (如 GVL/库管理器/Task Configuration)
      * 方法/动作: 0f 19 <self> <父(FB/PROGRAM)> <name> ... (父在第 2 位)
      * 设备对象: 0f 01 <self> <父(Device/从站/TaskConfig)> <name> ...
    """
    refs = []
    i = 0
    while i < len(meta):
        try:
            v, i = read_varint(meta, i)
        except Exception:
            break
        refs.append(v)
    # self 定位: 匹配自身 GUID
    self_pos = None
    for j, v in enumerate(refs):
        if v < len(strings):
            s = decode(strings[v]).strip().lower()
            if s == self_guid_lower:
                self_pos = j
                break
    # 父: 1468 段优先, 否则 self 后第一个 varint
    parent_ref = None
    for j, v in enumerate(refs):
        if v == META_PARENT_MARK and j + 1 < len(refs):
            parent_ref = refs[j + 1]
            break
    if parent_ref is None and self_pos is not None and self_pos + 1 < len(refs):
        parent_ref = refs[self_pos + 1]
    # 对象名: self 后第一个有意义字符串 (跳过 57/父GUID/空/True)
    name = None
    if self_pos is not None:
        for v in refs[self_pos + 1:]:
            if v == 17 or v >= len(strings) or v == APP_REF:
                continue
            s = decode(strings[v]).strip()
            if not s or (len(s) == 36 and "-" in s):
                continue
            if s in ("True", "False"):
                continue
            name = s
            break
    pg = None
    if parent_ref is not None and parent_ref < len(strings):
        s = decode(strings[parent_ref]).strip().lower()
        pg = s if (len(s) == 36 and "-" in s and s != ZERO_GUID) else None
    return name, pg, parent_ref


def all_refs(payload, limit=5470):
    """回退: 提取负载中所有 < limit 的 varint 引用。"""
    out = []
    i = 0
    while i < len(payload):
        try:
            v, i = read_varint(payload, i)
        except Exception:
            break
        if v < limit:
            out.append(v)
    return out


# ---------------- 主流程 ----------------

KNOWN_NAMES = {
    "7fd59d4c-5e8e-4f82-8521-507f6d68255d": "SoftMotion Axis Pool",
    "6470a90f-b7cb-43ac-9ae5-94b2338b4573": "ProjectRoot(工程根)",
    "7698bf3c-fcdd-4dab-9409-f5391e731c77": "Device",
    "11029987-8dbd-472f-be5f-2feeb1cced7d": "Plc Logic / Application",
    "e332f54a-a446-4af3-9e2e-ee2298cf2522": "库管理器",
    "8e2fb6e9-2c5b-4160-903c-506ed61d09a9": "Task Configuration",
    "cd7ea0c0-e176-4cfc-be4c-6555f6c9cbc5": "MainTask",
    "11c0fc3a-9bcf-4dd8-ac38-efb93363e521": "Project Information",
    "21fe9988-c007-4d22-b201-ba54de71a744": "Device Diagnose",
    "45e6260f-8633-4368-a580-2131dc496e98": "Network Configuration",
    "67dfde7e-3e58-4922-9bf7-b260004fc0ec": "LocalBus Config",
    "f6ace620-d49c-4e7a-96de-0df8b862119b": "Resource Usage",
}


def extract(project_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    extract_dir = os.path.join(out_dir, "extracted")
    os.makedirs(extract_dir, exist_ok=True)

    with zipfile.ZipFile(project_path) as z:
        z.extractall(extract_dir)
    print(f"[1] 解包完成: {extract_dir}")

    str_path = os.path.join(extract_dir, "__shared_data_storage_string_table__.auxiliary")
    strings = load_strings(str_path)
    with open(os.path.join(out_dir, "全部字符串.txt"), "w", encoding="utf-8") as f:
        for n, s in enumerate(strings):
            f.write(f"[{n}]\t{decode(s)}\n")
    print(f"[2] 字符串表: {len(strings)} 条")

    # GUID -> 字符串索引
    guid_idx = {}
    for n, s in enumerate(strings):
        t = decode(s).strip().lower()
        if len(t) == 36 and "-" in t:
            guid_idx.setdefault(t, n)

    objs = []
    for fn in sorted(os.listdir(extract_dir)):
        if fn.endswith(".object"):
            objs.append((fn[:-7], fn[:-7].lower()))
    objs.sort(key=lambda x: guid_idx.get(x[1], 10 ** 9))

    # meta 解析: 对象名 + 父节点 (解构项目树)
    meta_map = {}  # guid_lower -> (name, parent_guid|None, parent_ref)
    for fn in os.listdir(extract_dir):
        if fn.endswith(".meta"):
            guid = fn[:-5]
            try:
                data = open(os.path.join(extract_dir, fn), "rb").read()
                plen = struct.unpack("<I", data[16:20])[0]
                meta = data[20:20 + plen]
                meta_map[guid.lower()] = parse_meta(meta, guid.lower(), strings)
            except Exception:
                meta_map.setdefault(guid.lower(), (None, None, None))

    pous_dir = os.path.join(out_dir, "pous")
    os.makedirs(pous_dir, exist_ok=True)
    obj_lines = []
    report = []
    report.append("# 工程内容报告")
    report.append("")
    report.append(f"来源: `{project_path}`")
    report.append("")

    for name, guid in objs:
        idx = guid_idx.get(guid)
        # 通用名称推导: 对象自身 GUID 字符串在字符串表中的下一条
        # 非空且非 GUID 的字符串通常即对象名称 (每个工程都适用)。
        derived = None
        if idx is not None:
            for j in range(idx + 1, min(idx + 6, len(strings))):
                cand = decode(strings[j]).strip()
                if cand and not (len(cand) == 36 and "-" in cand):
                    derived = cand
                    break
        # 对象名优先取 meta（工程内自带的名字），否则查标准对象表 / 由父节点推导
        meta_name = meta_map.get(guid, (None, None, None))[0]
        label = meta_name or KNOWN_NAMES.get(name, derived or "?")
        obj_path = os.path.join(extract_dir, name + ".object")
        payload = load_payload(obj_path)
        xml = is_inline_string(payload)
        sections, left, err = parse_record_container(payload)

        if err is None and sections:
            # 记录容器: 每 section 的 B 引用 = 内容; 含 PROGRAM/FB/TYPE/VAR_GLOBAL
            # 关键字的 section 视为"声明头", 排到最前。
            sec_texts = []
            for cfg, recs in sections:
                # 同一 section 内同一字符串 id 会被多次引用 (如各块的 END_IF / 重复赋值行),
                # 必须按原序全量保留, 不能去重。
                tlist = []
                for A, B in recs:
                    if B is not None and B < len(strings):
                        tlist.append(B)
                sec_texts.append(tlist)
            HEADER_RE = re.compile(r"^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|TYPE|VAR_GLOBAL)\b")
            header = [t for t in sec_texts if any(
                HEADER_RE.match(decode(strings[i])) for i in t)]
            body = [t for t in sec_texts if t not in header]
            content_ids = []
            for grp in header + body:  # 声明头在前, 实现体在后
                for cid in grp:
                    content_ids.append(cid)
            mode = "record-container"
        else:
            task = parse_task_config(payload, strings)
            if task is not None:
                # 任务对象: 输出参数 + 挂载程序
                mode = "task"
                tparams, tcalls = task
                lines = []
                lines.append("// 任务参数: " + (" | ".join(tparams) if tparams else "(无)"))
                lines.append("// 挂载程序:")
                if tcalls:
                    lines += [f"//   - {c}" for c in tcalls]
                else:
                    lines.append("//   (无)")
                content_ids = []
            else:
                # 回退: 全部引用
                content_ids = []
                for r in all_refs(payload):
                    if r < len(strings) and r not in content_ids:
                        content_ids.append(r)
                mode = "fallback"

        # 内容文本:
        #  record-container 模式: B 引用按原序全量输出 —— CoDeSys 共享字符串表中
        #    相同文本共用同一 id, 同一对象内多处引用同一 id 是常态 (如各块的 END_IF),
        #    按 id/内容去重会丢行, 导致源码缺闭合语句。
        #  task 模式: lines 已在任务分支构造。
        #  fallback 模式: 保留按 id+内容去重 (该模式本就是"提取全部引用", 去重防膨胀)。
        if mode == "record-container":
            lines = [decode(strings[cid]) for cid in content_ids]
        elif mode == "task":
            pass
        else:
            lines = []
            seen = set()
            for cid in content_ids:
                s = decode(strings[cid])
                if s.strip() and s not in seen:
                    seen.add(s)
                    lines.append(s)

        m_parent = meta_map.get(guid, (None, None, None))[1] or ""
        obj_lines.append((name, label, m_parent, idx, len(payload), mode,
                          len(content_ids), xml is not None, err or ""))

        if xml:
            xml_path = os.path.join(out_dir, f"{re.sub(r'[^\\w一-鿿-]+', '_', label)}.xml")
            with open(xml_path, "w", encoding="utf-8") as f:
                f.write(xml)
            lines.append(f"[XML 已导出: {os.path.basename(xml_path)}]")

        if lines:
            safe = re.sub(r"[^\w一-鿿-]+", "_", label) or name[:8]
            with open(os.path.join(pous_dir, safe + ".txt"), "w", encoding="utf-8") as f:
                f.write(f"# {label}\n# GUID: {name}\n# 模式: {mode}\n\n")
                f.write("\n".join(lines))

        report.append(f"## {label}  (`{name[:8]}`…, {mode}, {len(content_ids)} 串)")
        report.append("")
        if lines:
            report.append("```")
            report.append("\n".join(lines[:400]))
            if len(lines) > 400:
                report.append(f"... (共 {len(lines)} 行, 已截断)")
            report.append("```")
        report.append("")

    # 对象表 (含父节点列)
    label_of = {}
    for o in obj_lines:
        label_of[o[0].lower()] = o[1]
    with open(os.path.join(out_dir, "对象表.md"), "w", encoding="utf-8") as f:
        f.write("| 对象 | 名称 | 父对象 | 字符串idx | 负载字节 | 模式 | 内容串 | XML | 错误 |\n")
        f.write("|---|---|---|---|---|---|---|---|---|\n")
        for name, label, m_parent, idx, plen, mode, cn, isxml, err in obj_lines:
            plabel = label_of.get(m_parent, m_parent[:8]) if m_parent else ""
            f.write(f"| `{name[:8]}` | {label} | {plabel} | {idx} | {plen} | {mode} | {cn} | {isxml} | {err or ''} |\n")

    # 项目树
    tree_lines = ["# 项目树", "", f"来源: `{project_path}`", ""]
    root = "6470a90f-b7cb-43ac-9ae5-94b2338b4573"
    tree_visited = set()
    def tree_render(g, indent):
        if g in tree_visited:
            return
        tree_visited.add(g)
        tree_lines.append("  " * indent + "- " + (label_of.get(g, g[:8])))
        for c in sorted(label_of):
            pc = meta_map.get(c, (None, None, None))[1]
            if g == root:
                # 根级对象: 父不在本工程或为根 (全零) 的都挂 ProjectRoot 下
                if pc is None or pc not in label_of:
                    tree_render(c, indent + 1)
            elif pc == g:
                tree_render(c, indent + 1)
    tree_render(root, 0)
    # 仍有未挂入的 (父不在本工程或为根) -> 挂到 ProjectRoot 下
    for g in sorted(label_of):
        if g not in tree_visited:
            pg = meta_map.get(g, (None, None, None))[1]
            tree_lines.append("- {} (父: {})".format(
                label_of.get(g, g[:8]), label_of.get(pg, pg or "根")))
    with open(os.path.join(out_dir, "项目树.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(tree_lines))

    with open(os.path.join(out_dir, "工程内容报告.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(report))

    print(f"[3] 导出 {len(objs)} 个对象完成 → {out_dir}")
    print(f"    对象表: 对象表.md, 报告: 工程内容报告.md, 全部字符串: 全部字符串.txt")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    proj = sys.argv[1]
    outd = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.abspath(proj)), "工程导出")
    extract(proj, outd)
