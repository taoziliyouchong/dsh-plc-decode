# -*- coding: utf-8 -*-
"""静态语义校验: 等价于编译检查 (无法驱动 LeadSysStudio GUI 编译时的替代验证)。
校验: ① 结构体成员存在性 ② 被调用的程序/动作/方法存在性 ③ 地址唯一性 ④ 数组下标越界
      ⑤ 未声明符号 (排除库/设备外部符号)。
用法: python check_project.py <pous目录>
"""
import io
import re
import sys
import glob
import os

if __name__ == "__main__" and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

POUS = sys.argv[1] if len(sys.argv) > 1 else "."

CJK = u"\u4e00-\u9fff"
ID_RE = re.compile(u"[\\w" + CJK + u"]+")
ST_HEADER_RE = re.compile(
    r"^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|INTERFACE|CLASS|TYPE|VAR(?:_GLOBAL|_INPUT|_OUTPUT|_IN_OUT)?)\b",
    re.M)

KEYWORDS = {
    "IF","THEN","ELSE","ELSIF","END_IF","FOR","TO","BY","DO","END_FOR","WHILE","REPEAT",
    "UNTIL","END_WHILE","END_REPEAT","CASE","OF","END_CASE","VAR","END_VAR","VAR_IN_OUT",
    "VAR_INPUT","VAR_OUTPUT","VAR_GLOBAL","VAR_GLOBAL_CONSTANT","VAR_GLOBAL_RETAIN",
    "VAR_GLOBAL_PERSISTENT","VAR_GLOBAL_RETAIN_PERSISTENT","VAR_TEMP","STRUCT","END_STRUCT",
    "TYPE","END_TYPE","FUNCTION_BLOCK","FUNCTION","PROGRAM","ACTION","METHOD","INTERFACE",
    "IMPLEMENTS","EXTENDS","CONSTANT","RETAIN","PERSISTENT","ARRAY","OF","POINTER","AT",
    "AND","OR","XOR","NOT","TRUE","FALSE","BOOL","INT","DINT","UDINT","UINT","REAL",
    "LREAL","WORD","DWORD","BYTE","STRING","SINT","USINT","TIME","TOD","DATE","DT",
}
# 库/设备外部符号 (库函数/FB/类型/设备对象/库实例), 大小写不敏感
STD = {
    "MC_Power","MC_Stop","MC_Reset","MC_Halt","MC_Jog","MC_MoveVelocity","MC_SetPosition",
    "MC_Home","MC_MoveAbsolute","MC_MoveRelative","MC_MoveAdditive","MC_GearIn","MC_GearOut",
    "MC_Direction","SMC3_ReinitDrive","SMC3_PersistPosition","AXIS_REF","AXIS_REF_SM3",
    "AXIS_REF_ETC_DS402_CS","ETCSlave","TON","TOF","TP","R_TRIG","F_TRIG","CTU","CTD","CTUD",
    "LIMIT","MIN","MAX","ABS","ADR","SEL","MUX","MOVE","SHR","SHL","MOD","DWORD_TO_UDINT",
    "LREAL_TO_REAL","TO_DINT","TO_UDINT","TO_DWORD","TO_INT","TO_UINT","TO_REAL","TO_LREAL",
    "TO_BOOL","ANY_TO_TIME","INT_TO_DINT","DINT_TO_INT","TIME_TO","REAL_TO","STRING_TO",
    "UDINT_TO","BYTE_TO","WORD_TO","DINT_TO_REAL","SM3_Basic","positive","negative","normal",
    "Fastest","shortest","xConfigFinished","xDistributedClockInSync","xError","fbeFBError",
    "wID","wStatusWord","dwDigitalInputs","wState","SetOpMode","wOpMode","bVirtual",
    "wCommunicationState","bDriveStartRealState","bRegulatorRealState","nAxisState",
    "fActVelocity","fSetPosition","fActPosition","fActTorque","dwPosOffsetForResiduals",
    "In","Out","Master","Slave","Axis","Execute","Enable","Position","Velocity","Acceleration",
    "Deceleration","Jerk","Direction","Distance","BufferMode","Done","Busy","Active",
    "CommandAborted","Error","ErrorId","ErrorID","InGear","InVelocity","Status","bRegulatorOn",
    "bDriveStart","Mode","RatioNumerator","RatioDenominator","Q","ET","CLK","IN","PT",
    "JogForward","JogBackward",
    "High_Speed_IO_Module","LocalBus_Master_Module",
}
STD_UPPER = {s.upper() for s in STD}
PARAM_NAMES = {"IN","PT","Q","ET","CLK","CV","RESET","CU","PV","COUNT","MAXVALUE"}

# 数组/结构体声明解析：从各 POU 的实际声明里取类型，不预设变量名
ARRAY_DECL_RE = re.compile(u"ARRAY\\s*\\[\\s*(-?\\d+)\\s*\\.\\.\\s*(-?\\d+)\\s*\\]\\s*OF\\s+"
                           u"(?:ARRAY\\s*\\[[^\\]]*\\]\\s*OF\\s+)?([\\w" + CJK + u"]+)")
STRUCT_DECL_RE = re.compile(u"^([\\w" + CJK + u"]+)(?:\\s+AT\\s+%[^\\s]+)?\\s*:\\s*([\\w" + CJK + u"]+)\\s*(?:;|:=)")


def parse_decl(line):
    """声明行 → ('array', lo, hi, 元素类型) / ('struct', 类型名) / None"""
    m = ARRAY_DECL_RE.search(line)
    if m:
        try:
            return ("array", int(m.group(1)), int(m.group(2)), m.group(3))
        except ValueError:
            return None
    m = STRUCT_DECL_RE.match(line)
    if m:
        return ("struct", m.group(2))
    return None


def read_pou(path):
    txt = open(path, encoding="utf-8-sig").read()
    body = [l for l in txt.splitlines() if not l.startswith("#")]
    return "\n".join(body).lstrip()


def strip_comments(txt):
    """剥 ST 注释: // 行注释 + (* *) 块注释。栈式扫描, 正确处理嵌套/未闭合 ((* 之后全视为注释)。"""
    out = []
    i, depth, n = 0, 0, len(txt)
    while i < n:
        if txt.startswith("(*", i):
            depth += 1
            i += 2
        elif txt.startswith("*)", i) and depth > 0:
            depth -= 1
            i += 2
        elif depth > 0:
            i += 1
        elif txt.startswith("//", i):
            j = txt.find("\n", i)
            i = n if j == -1 else j + 1
        else:
            out.append(txt[i])
            i += 1
    return "".join(out)


def extract_var_decls(txt):
    decls = {}
    for m in re.finditer(r"(?s)(?:VAR|VAR_IN_OUT|VAR_INPUT|VAR_OUTPUT|VAR_TEMP)\b(.*?)(?=\bEND_VAR)", txt):
        for line in m.group(1).splitlines():
            line = line.strip()
            if not line or line.startswith(("//", "(*", "*)")):
                continue
            mm = re.match(u"^([\\w" + CJK + u"]+)\\s*:", line)
            if mm:
                decls[mm.group(1)] = line
    return decls


def extract_globals(txt):
    names, addrs, decls = set(), {}, {}
    for m in re.finditer(r"(?s)VAR_GLOBAL(.*?)(?=\bEND_VAR)", txt):
        for line in m.group(1).splitlines():
            line = line.strip()
            if not line or line.startswith(("//", "(*", "*)")):
                continue
            am = re.search(r"AT\s+(%[A-Z][A-Za-z]*\d+(?:\.\d+)?)", line)
            nm = re.match(u"^([\\w" + CJK + u"]+)", line)
            if nm:
                names.add(nm.group(1))
                decls[nm.group(1)] = line
                if am:
                    addrs.setdefault(am.group(1), nm.group(1))
    return names, addrs, decls


def extract_dut_fields(txt):
    fields = set()
    for line in txt.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        if ":" in line and not line.startswith(("TYPE", "END_TYPE", "STRUCT", "END_STRUCT")):
            mm = re.match(u"^([\\w" + CJK + u"]+)\\s*:", line)
            if mm:
                fields.add(mm.group(1))
    return fields


def enum_members(txt):
    m = set()
    t = txt.split("END_TYPE")[0]
    if "(" in t and "STRUCT" not in t:
        body = t.split("(", 1)[1]
        for mm in re.finditer(u"([\\w" + CJK + u"]+)\\s*(?::=\\s*\\d+)?", body):
            m.add(mm.group(1))
    return m


# ---------------- 加载 ----
pous = {}
for f in glob.glob(os.path.join(POUS, "*.txt")):
    name = os.path.basename(f)[:-4]
    txt = read_pou(f)
    # 跳过设备对象（fallback 文本提取，非 ST 代码）：前 2000 字符里找不到任何 ST 声明头
    if not ST_HEADER_RE.search(txt[:2000]):
        continue
    pous[name] = txt

dut_fields = {}
declared = set()
locals_map = {}
globals_map = {}
global_decls = {}         # 全局变量名 -> 声明行（数组/结构体类型推断用）
enum_names = set()
global_visible = set()   # 仅"跨 POU 可见"声明 (全局/枚举/DUT 类型与字段/调用 POU)
local_pool = {}          # name -> {局部声明名: 原行}
for name, txt in pous.items():
    if txt.startswith("TYPE"):
        if "STRUCT" in txt.split("END_TYPE")[0]:
            m = re.match(u"TYPE\\s+([\\w" + CJK + u"]+)", txt)
            dname = m.group(1) if m else name
            dut_fields[dname] = extract_dut_fields(txt)
            global_visible.add(dname)
        else:
            en = enum_members(txt)
            if en:
                enum_names |= en
                declared |= en
                global_visible |= en
    elif "VAR_GLOBAL" in txt:
        n, a, d = extract_globals(txt)
        globals_map[name] = (n, a)
        global_decls.update(d)
        declared |= n
        global_visible |= n
    else:
        loc = extract_var_decls(txt)
        locals_map[name] = loc
        local_pool[name] = loc
        declared |= set(loc)
callables = set(pous.keys())
for flds in dut_fields.values():
    declared |= flds
    global_visible |= flds
declared |= set(dut_fields.keys())   # DUT 类型名也是声明
global_visible |= callables

# ---------------- 校验 1: 结构体成员 + 数组下标 ----------------
def decl_kinds(name):
    """该 POU 可见的数组/结构体变量（全局 + 本 POU 局部）：{变量名: 声明解析结果}"""
    kinds = {}
    for var, line in global_decls.items():
        k = parse_decl(line)
        if k:
            kinds[var] = k
    for var, line in locals_map.get(name, {}).items():
        k = parse_decl(line)
        if k:
            kinds[var] = k
    return kinds


struct_field_issues = []
for name, txt in pous.items():
    if txt.startswith("TYPE"):
        continue
    kinds = decl_kinds(name)
    if not kinds:
        continue
    txt = strip_comments(txt)
    # 数组元素成员：base[idx].field
    for m in re.finditer(u"([\\w" + CJK + u"]+)\\s*\\[\\s*([^\\]]+?)\\s*\\]\\s*\\.\\s*([\\w" + CJK + u"]+)", txt):
        base, idx, field = m.group(1), m.group(2).strip(), m.group(3)
        k = kinds.get(base)
        if not k or k[0] != "array":
            continue
        dut = k[3]
        if dut in dut_fields and field not in dut_fields[dut]:
            struct_field_issues.append(u"%s: %s[%s].%s 不是 %s 的字段" % (name, base, idx, field, dut))
        if idx.isdigit() and not (k[1] <= int(idx) <= k[2]):
            struct_field_issues.append(u"%s: %s[%s] 越界 (%d..%d)" % (name, base, idx, k[1], k[2]))
    # 结构体实例成员：var.field
    for m in re.finditer(u"([\\w" + CJK + u"]+)\\s*\\.\\s*([\\w" + CJK + u"]+)", txt):
        var, field = m.group(1), m.group(2)
        k = kinds.get(var)
        if not k or k[0] != "struct":
            continue
        dut = k[1]
        if dut in dut_fields and field not in dut_fields[dut]:
            struct_field_issues.append(u"%s: %s.%s 不是 %s 的字段" % (name, var, field, dut))
    # 纯数组下标越界：base[idx]（后面不跟 .field，避免与上一条重复）
    for m in re.finditer(u"([\\w" + CJK + u"]+)\\s*\\[\\s*(\\d+)\\s*\\](?!\\s*\\.)", txt):
        base, idx = m.group(1), int(m.group(2))
        k = kinds.get(base)
        if k and k[0] == "array" and not (k[1] <= idx <= k[2]):
            struct_field_issues.append(u"%s: %s[%d] 越界 (%d..%d)" % (name, base, idx, k[1], k[2]))

# ---------------- 校验 2: 调用存在性 ----------------
call_issues = []
for name, txt in pous.items():
    if txt.startswith("TYPE"):
        continue
    txt = strip_comments(txt)
    for m in re.finditer(u"(?<![\\w" + CJK + u"])([A-Z][\\w" + CJK + u"]*)\\s*\\(", txt):
        callee = m.group(1)
        if callee in callables or callee in KEYWORDS or callee.upper() in STD_UPPER:
            continue
        if callee.startswith(("MC_", "TON", "R_TRIG", "F_TRIG", "SM3", "CTU", "TP", "TOF")):
            continue
        if callee in declared:
            continue
        call_issues.append(u"%s: 调用未定义 %s()" % (name, callee))

# ---------------- 校验 3: 地址唯一 ----------------
addr_issues = []
all_addrs = {}
for gvl, (n, a) in globals_map.items():
    for addr, var in a.items():
        if addr in all_addrs and all_addrs[addr] != var:
            addr_issues.append(u"地址重叠: %s 被 %s(%s) 与 %s 同时占用" % (addr, all_addrs[addr], gvl, var))
        all_addrs.setdefault(addr, var)

# ---------------- 校验 4: 未声明符号 ----------------
undef_issues = []
for name, txt in pous.items():
    if txt.startswith("TYPE"):
        continue
    clean = strip_comments(txt)
    for t in set(ID_RE.findall(clean)):
        if t in KEYWORDS or t in declared or t in enum_names or t in callables:
            continue
        if t.upper() in STD_UPPER or t.upper() in PARAM_NAMES:
            continue
        if t.isdigit() or re.fullmatch(r"\d+[A-Za-z]+", t) or re.fullmatch(r"(MB|MW|MX|QX|QB|QI|IX|IW|QD)\d+", t):
            continue
        if t.startswith(("MC_", "SM3_", "SMC3", "AXIS", "ETC", "FB_", "ST_", "DUT_", "GVL",
                         "TON", "R_TRIG", "F_TRIG", "CTU", "TP", "TOF")):
            continue
        if len(t) == 1 or t in ("LeadSysStudio",):
            continue
        undef_issues.append(u"%s: 未声明符号 %s" % (name, t))

# ---------------- 校验 5: POU 声明头缺失 ----------------
header_issues = []
for name, txt in pous.items():
    if txt.startswith("TYPE"):
        continue
    first = ""
    for l in txt.splitlines():
        l = l.strip()
        if not l or l.startswith("//"):
            continue
        first = l
        break
    if not re.match(u"^(PROGRAM|FUNCTION_BLOCK|FUNCTION|VAR_GLOBAL)(?=\\s|$)", first):
        header_issues.append(u"%s: 缺少 POU 声明头 (首行应为 PROGRAM/FUNCTION_BLOCK/FUNCTION/VAR_GLOBAL, 当前: %s)"
                             % (name, first[:40] if first else "(空)"))

# ---------------- 校验 6: 跨 POU 引用他人局部声明 ----------------
cross_issues = []
local_all = set()
for loc in local_pool.values():
    local_all |= set(loc)
for name, txt in pous.items():
    if txt.startswith("TYPE"):
        continue
    own = set(local_pool.get(name, {}))
    clean = strip_comments(txt)
    for t in set(ID_RE.findall(clean)):
        if t in own or t in global_visible or t in KEYWORDS or t.isdigit():
            continue
        if t.upper() in STD_UPPER or t.upper() in PARAM_NAMES:
            continue
        if t in local_all:
            for oname, loc in local_pool.items():
                if oname != name and t in loc:
                    cross_issues.append(u"%s: 引用了 %s 的局部声明 %s (编译将报未声明, 应把声明移到本 POU 或全局)"
                                        % (name, oname, t))
                    break

# ---------------- 输出 ----------------
print("=" * 64)
print(u"静态语义校验  (等价编译检查)")
print("=" * 64)
print(u"POU 数 %d | DUT 字段组 %d | 全局声明 %d | 枚举成员 %d" %
      (len(pous), len(dut_fields), sum(len(v[0]) for v in globals_map.values()), len(enum_names)))

print(u"\n[1] 结构体成员/数组越界:")
if struct_field_issues:
    for e in sorted(set(struct_field_issues)):
        print("  ✗", e)
else:
    print("  ✓ 全部有效")

print(u"\n[2] 程序/动作/方法调用:")
if call_issues:
    for e in sorted(set(call_issues)):
        print("  ✗", e)
else:
    print("  ✓ 全部存在")

print(u"\n[3] AT 地址唯一性:")
if addr_issues:
    for e in sorted(set(addr_issues)):
        print("  ✗", e)
else:
    print("  ✓ 无重叠")

print(u"\n[4] 未声明符号 (排除库/设备外部, 需人工核对):")
if undef_issues:
    for e in sorted(set(undef_issues)):
        print("  ?", e)
else:
    print("  ✓ 无")

print(u"\n[5] POU 声明头:")
if header_issues:
    for e in sorted(set(header_issues)):
        print("  ✗", e)
else:
    print("  ✓ 全部 POU 有声明头")

print(u"\n[6] 跨 POU 非法局部引用:")
if cross_issues:
    for e in sorted(set(cross_issues)):
        print("  ✗", e)
else:
    print("  ✓ 无")

print(u"\n结论: 静态等价检查; 最终以 LeadSysStudio 编译为准 (工程已在 IDE 打开)")
