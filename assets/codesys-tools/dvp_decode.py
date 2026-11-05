# -*- coding: utf-8 -*-
"""
dvp_decode.py — 台达 WPLSoft/ISPSoft DVP 工程文件解码器

用法:
    python dvp_decode.py "C:\\projects\\demo.dvp" [-o 输出目录]

功能:
  1. 文件结构（机型 / TypeBegin 块 / SMT 块分段）
  2. 段落注释 SegCmt（每段功能说明）
  3. 设备注释 Device Comment（I/O 定义全量，0x0A 分隔解析）
  4. 程序指令表（全段行分组反汇编；无 <SMT> 标记的工程走整块 fallback）
  5. 生成 <输出目录>\\解码报告.md（或打印到 stdout）

编码规则:
  指令前缀 42 00 XX <A> <B>（5 字节；A/B 多为 00，尾=10 时疑为链式/复数操作数指令）:
     00=SET, 07=RST, 03=TMR, 28=MOV, 3A=SUB, F6=DIV16,
     56=SFTL?（M M K K）, 60=ZRST?（M M 区间）, C4=MODRW?（K H D——站号/寄存器/数据）,
     38=MUL16?, F4=CMP?（比较）, 3C=MULD?（速度×速比→频率）, 69=DBON（On 位判定）,
     40=INC?（计数）, 41=INC?, 54=ZCP?（区间比较）, F5/F7/39/3B=DIVK?（换算链）,
     29=DMOV?, 06=HS?, 0F=END?
  操作数前缀 80/86/88 0X（3 档，值=设备号直编码 LE）:
     02=D 寄存器, 03=H 立即数, 04=K 立即数, 05=M 位（86/88 多见于扩展区/变体）, 07=T 定时器,
     01=C 计数器, 0A=Y 输出位
  行头 12 05 E8 03 00 XX（6 字节，XX=行类型）
  行尾 TT 19 NN 00 00（待对照）; 空填充 52 00 00 00 00;
  操作数链连接 90 xx xx xx yy（5 字节，输出 |）; 栈指令: 56=MPS, 59=MRD, 54=MPP
  紧凑位指令: 32 0a <n> = OUT Y{n}；22 0a <n>/22 09 <n> = AND 触点读 Y/X；
    19/c9 等未定前缀保持原样
  操作数显示口径: H 立即数按十六进制；X/Y 按八进制（DVP 端子编号为八进制，
    字节 8→软件 X10、15→X17）；M/T/C/D/K 为十进制。设备注释的 X/Y 键同步换算。
"""
import sys
import os
import re

def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()

def find_all(text, needle):
    out = []
    idx = text.find(needle)
    while idx >= 0:
        out.append(idx)
        idx = text.find(needle, idx + 1)
    return out

def disp_num(t, val):
    """操作数按**软件显示口径**输出。
    文件内部一律存十进制数值，软件按设备类型换进制显示：
      H 立即数 → 十六进制（字节值 134=0x86、8193=0x2001）；
      X / Y    → 八进制（DVP I/O 端子编号本就是八进制，无 X8/X9；字节值 8 = 软件 X10，
                  字节值 15 = 软件 X17；ZRST 区间 Y8~Y15 即软件 Y10~Y17）；
      M / T / C / D / K → 十进制（与软件一致）。"""
    if t == "H":
        return format(val, "X")
    if t in ("X", "Y"):
        return format(val, "o")
    return str(val)

def decode_operand(rec):
    # 操作数类型前缀有 0x80 / 0x86 / 0x88 三档（疑似"页"变体：0x86 见于 M2000+ 区，
    # 0x88 见于 M40 等；值均为设备号直编码，直接显示编号即可）。
    # v17: 0x84 也是位组前缀（16 位组 K4M<n>），旧版只认 80/86/88 → 整条操作数被丢。
    if rec[0] not in (0x80, 0x84, 0x86, 0x88):
        return None
    sub = rec[1]
    val = rec[2] | (rec[3] << 8)
    # 类型表：0x09=X 输入位（紧凑位指令 22 09 08 = AND X8，与设备注释的 X 编号闭合）；
    # 0x0A=Y 输出位；0x01=C 计数器（值=编号）。
    # 注意：type=0x15 虽值域常与 M 编号重合，但存在 40,41,42…71 完美递增的记录，
    # 判为梯形图行号索引而非 M 触点——不进入类型表。
    mapping = {0x02: "D", 0x03: "H", 0x04: "K", 0x05: "M", 0x07: "T",
               0x01: "C", 0x09: "X", 0x0A: "Y",
               # 0x08 = 变址寄存器 E（如 MOV D E / RST M E）
               0x08: "E", 0x85: "M"  # 0x85 = 带变址的位组（RST M620E3）
               }
    return (mapping.get(sub, f"80_{sub:02X}"), val)

# 紧凑位指令前缀表（5 字节记录 = [cmd][type][val_lo][val_hi][00]，
# 触点/线圈类指令，无 42 00 前缀）。
# 已定名（与 WPLSoft 指令表配对）：
#   前缀 12 = 触点族（LD/AND 由行内位置界定），类型字节区分设备:
#     12 05 <n> = LD M<n>
#     12 09 <n> = LD X<n>
#     12 07 <n> = AND T<n>
#   前缀 32 = OUT；前缀 22 = AND 触点
#   前缀 c6 19 <n> = ANDF X<n>（下降沿触点）
#   前缀 b4/b6/b9 19/09 <n> = ANDP X<n> 变体（上升沿触点；
#     首字节疑为分支位置标记——MPS/MRD/MPP 后缀不同，待更多对照，保留 ?）
# 未定名前缀（均具触点/线圈特征，? 前缀待 WPLSoft 对照，不冒充确认）:
#   0x14/0x16/0x26/0x19/0xC9/0xB9/0xB2/0xC2/0xB4/0xC6/0xC4/0xB6
#   0x19 两义：既可能是行号索引，也可能是触点（命中设备注释的在指令流里按触点；
#   显示时保留 ? 标记，需 WPLSoft 对照确认）。
COMPACT_CMD = {
    # v7: 见上方 decode_compact 与 COMPACT_NAMES/COMPACT_Q 定义
}
# type 0x15 语义由前缀决定:
#   前缀 14/16 → 行号索引（存在 40,41,…71 递增的记录）——主循环按 rec[1]==0x15 且前缀∈{14,16} 吞
#   前缀 26/19/其他 → M 触点
# 故: 0x15 进类型表（M），但 decode_compact 只对「非行号前缀」应用 0x15 判定
COMPACT_TYPES = {0x05: "M", 0x09: "X", 0x0A: "Y",
                 0x07: "T", 0x01: "C1>", 0x02: "D", 0x03: "H", 0x04: "K",
                 0x19: "X", 0x15: "M",
                 # 0x1A = Y 页（B/C 系沿触点的 Y 页变体）；缺这一页会整条沿触点丢失，
                 # 计数器看上去"没有脉冲源"。
                 0x1A: "Y"}
# 行号索引前缀（保留吞 5B 语义）：14/16 为行号标记
ROWIDX_PREFIX = {0x14, 0x16}

# 2026-11-05：认不出的记录台账。disasm 每跳一条未识别记录就往这里记一笔
# （段号, 行号, 字节原文），main 末尾聚合成「未识别记录」一节。
# 这不是猜语义，是把「读不出来」变成看得见的账——用户能据此对照 WPLSoft 指令表。
UNKNOWN_RECS = []

# 触点/线圈指令前缀：
#   12 触点族（LD/AND/T 页）、32=OUT、22=AND/ANI
#   B 系（B4/B6/B2/B9）= ANDP（上升沿，置位侧）
#   C 系（C6/C9/C2/C4）= ANDF（下降沿，复位侧）
#   同一设备 M 的"B→SET / C→RST"对＝位置信号到达/离开。
# 类型页: 0x05=M、0x09=X、0x0A=Y、0x19=X 脉冲页、0x15=M 触点
COMPACT_NAMES = {
    (0x12, 0x05): "LD", (0x12, 0x09): "LD", (0x12, 0x07): "AND", (0x12, 0x02): "LD",
    (0x12, 0x0A): "LD", (0x12, 0x19): "LD", (0x12, 0x15): "LD",
    (0x32, 0x05): "OUT", (0x32, 0x0A): "OUT", (0x32, 0x19): "OUT", (0x32, 0x15): "OUT",
    (0x22, 0x05): "ANI", (0x22, 0x09): "AND", (0x22, 0x0A): "AND",
    (0x22, 0x19): "AND", (0x22, 0x02): "AND", (0x22, 0x07): "AND", (0x22, 0x15): "AND",
    (0x26, 0x19): "AND", (0x26, 0x15): "AND",
    (0x14, 0x19): "LD", (0x14, 0x05): "LD", (0x14, 0x0A): "LD",
    (0x16, 0x05): "LD", (0x16, 0x0A): "LD", (0x16, 0x19): "LD",
}
# B/C 系沿触点：B=ANDP、C=ANDF，全类型页
# 2026-11-05：B 系补 0x07（T 页）/ 0x1A（Y 页）——C 系早就有 0x1A 的实证注释，
# B 系漏页会让上升沿触点整条消失；本机 16 份工程实测 B 系出现类型页 {05,07,09,15,17,19,1A}，
# 其中 0x17 页语义未定，暂不映射（宁缺不猜），其余补齐。
for _p in (0xB4, 0xB6, 0xB2, 0xB9):
    for _t in (0x05, 0x07, 0x09, 0x0A, 0x15, 0x19, 0x1A):
        COMPACT_NAMES[(_p, _t)] = "ANDP"
for _p in (0xC6, 0xC9, 0xC2, 0xC4):
    for _t in (0x05, 0x09, 0x0A, 0x15, 0x19, 0x1A):
        COMPACT_NAMES[(_p, _t)] = "ANDF"
# 未定名前缀（0x19 两义：行号索引变体 vs 触点）——按类型页分流：
#   19 07/0A/09（T/Y/X 类型页）= AND 触点
#   19 05（M 类型页）两义：命中设备注释 M 表的按触点；否则按行号吞。
COMPACT_Q = {}
COMPACT_NAMES[(0x19, 0x07)] = "AND"   # T 页触点
COMPACT_NAMES[(0x19, 0x0A)] = "AND"   # Y 页触点
COMPACT_NAMES[(0x19, 0x09)] = "AND"   # X 页触点
COMPACT_NAMES[(0x19, 0x05)] = "AND"   # M 页触点
# 14/16 + 0x15 也是 **M 触点**（值=编号），不是行号索引——
#   字节序列 `12 05 … | 14 15 … | 12 09 …` 对 WPLSoft 梯形图是 M·M·X 串联。
#   早期「递增序列＝行号索引」的观察据此存疑，按触点理解更稳。
COMPACT_NAMES[(0x14, 0x15)] = "AND"
COMPACT_NAMES[(0x16, 0x15)] = "AND"
# 0x24 + 0x19 也是触点（X 页），漏映射会逐字节跳过、把触点丢了。
COMPACT_NAMES[(0x24, 0x19)] = "AND"

def decode_compact(rec):
    """紧凑位指令 5 字节记录（触点/线圈），不在 42 00 前缀体系内。
    名字优先级: COMPACT_NAMES（已核对）> COMPACT_Q（? 待对照）。
    0x15 类型仅在前缀非行号索引时参与判定（否则由主循环吞 5B 为行号）。
    仅当 cmd 已知、type 在表内、尾部为 00 时判定，避免误吞其它未知记录。"""
    if rec[1] not in COMPACT_TYPES:
        return None
    if rec[4] != 0x00:
        return None
    # 14/16 + 0x15 是 M 触点（见 COMPACT_NAMES 注释），不再当行号索引吞掉
    # if rec[1] == 0x15 and rec[0] in ROWIDX_PREFIX:
    #     return None
    val = rec[2] | (rec[3] << 8)
    name = COMPACT_NAMES.get((rec[0], rec[1])) or COMPACT_Q.get(rec[0])
    if name is None:
        return None
    # 0x19+0x05 一律当 M 触点：行号索引的前缀是 14/16（见 ROWIDX_PREFIX），
    # 19 页上不需要再挡。
    t = COMPACT_TYPES[rec[1]]
    if t == "C1>":
        return f"{name} C{val}"
    return f"{name} {t}{disp_num(t, val)}"

CMD_MAP = {
    # 指令名映射（按 WPLSoft 指令表与操作数形态核对；带 ? 的仍属推断）
    0x00: "SET", 0x07: "RST", 0x03: "TMR", 0x3A: "SUB",
    0x28: "MOV",   # 操作数形态 K→D / H→D / D→D
    0x56: "SFTLP",  # 脉冲型移位寄存器（M M K K）
    0x60: "ZRST",  # 区域清零（M M 区间）
    0xC4: "MODWR",  # MODBUS 寄存器写（K H D）
    0x38: "MUL16",  # 16 位乘（D K D；与 0xF4 同指令不同操作数形态）
    0xF6: "DIV16",  # 16 位除（D K D）
    0xF4: "MUL16",  # 16 位乘（D D D）
    0x3C: "DMUL",  # 32 位乘（C K D）
    # 乘/除一族：两个功能码分别对应 16 位 / 32 位（或常数 / 寄存器）两种操作数形态
    0x39: "ADD",   # 3 操作数 D|D|D：加法
    0x3B: "DIV",   # 3 操作数 D|D|D：除法（长度/数量换算）
    0xF5: "MUL",   # 3 操作数 D|D|K/D：乘法（直径→周长 这类换算）
    0xF7: "DIV",   # 3 操作数 D|D|D：除法（周长→一圈距离 这类换算）
    0x3D: "MUL",   # 3 操作数 D|D|K：乘法（长度→脉冲 这类换算）
    0x3F: "DIV",   # 3 操作数 D|D|D/K：除法（脉冲数换算）
    0x0F: "END",   # 程序结束标记
    0x41: "INC", 0x40: "INC",   # 单 D 操作数递增计数
    0x54: "ZCP",   # 3 操作数 K K D：区间比较
    0x06: "DCNT",  # C K：高速计数器设定（参数 K 与字节 K 之间有取模偏移）
    0x05: "CNT",   # 16 位计数器（API 05）
    0x29: "DMOV",   # 32 位复制（C→D）
    0x68: "BON",   # On 位判定（API 44 的 16 位形态）；位组前缀 0x84=16 位、0x88=32 位
    0x69: "DBON",  # On 位判定（API 44 的 32 位形态）；S=来源位组、D=结果位、N=位号（来自寄存器）
}

# ── 推断映射（按操作数形态推断）──
# 这些**不是**核对过的名字：只按「操作数形态 + 同族相邻码 + 工程语义」推断，
# 输出一律带 `?` 前缀（如 ?DRVI），报告末尾附依据表。核对手册后应逐条转正或改判。
GUESS_CMD = {
    0x3E: ("DIV", "3 操作数 D K D：16 位除（与 0x3B 同名的另一操作数形态）", "已核"),
    0x0D: ("PLS", "单一位操作数，紧跟 RST/AND 序列，靠后续触点取一个扫描周期的脉冲；与 0x00=SET（持续置位）用法区分", "中"),
    0x1A: ("RST", "带位组/变址的操作数：与 0x07=RST 是同一条指令的位组变址形态", "已核"),
    0x94: ("ALT", "仅 1 个位操作数：交替输出", "已核"),
    0x8D: ("DABSD", "4 操作数 D|D|M|K：绝对位置检出（不是高速计数置位）", "已核"),
    0x8C: ("DABSR", "4 操作数 D|C|M|K：与 0x8D=DABSD 同族，参数换成计数器 → 绝对位置检出复位", "中"),
    0x8A: ("SER", "4 操作数 D|D|D|K：数据检索", "已核"),
    0x5A: ("WSFLP", "4 操作数 D|D|K|K：位移写入（第一个操作数常由随机数产生）", "已核"),
    0x5D: ("DDRVI", "4 操作数 K|K|Y|Y：32 位相对定位", "中"),
    0x5F: ("DDRVA", "4 操作数 K|D|Y|Y：32 位绝对定位", "已核"),
    0x87: ("DPLSR", "4 操作数 D|K|D|Y：带加减速脉冲输出", "已核"),
    0xAB: ("DVSPO", "4 操作数 D|D|D|Y：变速脉冲输出", "已核"),
    0xF1: ("DMOVR", "3 操作数 32 位浮点常数|D：32 位浮点传送（旧标 DMOV 是误读）", "已核"),
    0x72: ("FLT", "2 操作数 D|D：整数转浮点（浮点链起点）", "已核"),
    0x22: ("INT", "2 操作数 D|D：浮点转整数（浮点链末端）", "已核"),
    0x83: ("DPLSY", "3 操作数 D|K|Y：32 位脉冲输出", "已核"),
    0x1C: ("FEND", "无操作数：位于中断程序之前 → 第一扫描结束", "已核"),
    0x16: ("IRET", "无操作数：位输出之后、END 之前 → 中断返回（不是 FEND）", "已核"),
    0x4C: ("MODRW", "5 操作数 K K K D K：MODBUS 多寄存器读写", "已核"),
    0x71: ("DSQR", "2 操作数 D|D：32 位平方根（旧标 XCH 是误读）", "已核"),
    0x2E: ("BMOV", "3 操作数 D D K：块传送（不是区间比较）", "已核"),
}
GUESS_CMP_REL = {
    0x00: "=", 0x02: "<>", 0x04: ">", 0x06: "<", 0x08: "<=", 0x0a: ">=",
    # 奇数尾字节按「OR 逻辑 + 前一档关系」推断
    0x01: "OR=", 0x03: "OR<>", 0x05: "OR>", 0x07: "OR<", 0x09: "OR<=", 0x0b: "OR>=",
    # 0x1f：定时器当前值与常数/寄存器比较，后接 RST/SET/OUT 或 ANI，
    # 按"到达设定值"判 >=
    0x1f: ">=",
}

def guess_cmd(code):
    g = GUESS_CMD.get(code)
    if not g or g[0] == '??':
        return None
    # 把握＝已核/中 的当已定用（不带 ?）；只有"低"仍带 ? 提示存疑
    return g[0] if g[2] in ('已核', '中') else f"?{g[0]}"

def guess_cmp(rec):
    """比较族：关系码已定（08、0a 已核对，其余按步长 2 推），逻辑连接（LD/AND/OR）由网络位置决定、不逐条标。
    输出 CMP(关系) —— 不带 ?，关系本身当已定用；要区分 LD/AND 时看它在网络里的位置。"""
    rel = GUESS_CMP_REL.get(rec[2])
    if not rel:
        return None
    return f"CMP({rel})"

# 未定名功能码（按操作数形态整理，等 WPLSoft 指令表核对后再定名，不冒充）：
#   0x5D / 0x5F 4 操作数（脉冲数、频率、脉冲输出 Y、方向 Y）——脉冲定位输出族。
#       0x5F 只出现在 Y0 且脉冲数取 16 位量级；0x5D 出现在 Y0/Y2/Y3，
#       第一操作数可为 32 位常数（长距离常量）或 D 寄存器对
#       → 判为 16 位/32 位两种形态（DRVI/DDRVI 一族，相对/绝对未定）。功能码第 4 字节 = 0x01。
#   0x83        3 操作数（频率、K、Y 输出）——变速/连续脉冲输出（K＝不计数连续走），点动段用。
#   0x0D        首操作数为位，其后跟一条比较记录 + 位/常数（多见于长行程/联锁段）。
#   0x1C        无操作数，夹在 RST Y 与下一个 LD M 之间（网络/分支标记类）。
#   0x16        无操作数，程序末尾 END 之前（疑 FEND）。
#   0x18        出现在 <SMT> 段头正前方，非程序区记录，不要当指令。

# 比较指令族: [e2/e4/e6/e9][00/10][尾][00][00/10] + 操作数对。
# 0b 00 00 00 00 为 ORB/ANB 块连接。
# 已定名（操作数对匹配度闭环）:
#   e4 10 0a + (C, D) = LD>= C D
#   e2 00 08 + (C, D) = AND<= C D
#   e6 10 0a + (C, D) = LD<= C D
#   e6 10 08 + (C, D) = AND<= C D
#   e4 10 02 + (D, D) = AND（32 位双字）
#   e9 00 0a + (D, D) = AND>=
# 注意: 同一码在逻辑栈首/块中语境下可能显示 LD/AND 差异；本实现按常见语境定名，
# 已知偏差以注释标注，不冒充。
CMP_NAMES = {
    (0xe4, 0x10, 0x0a): "LD>=",
    (0xe2, 0x00, 0x08): "AND<=",
    (0xe6, 0x10, 0x0a): "LD<=",
    (0xe6, 0x10, 0x08): "AND<=",
    (0xe9, 0x00, 0x0a): "AND>=",
    (0xe9, 0x00, 0x08): "AND<=",
    (0xe2, 0x00, 0x0a): "AND<=",
    (0xe4, 0x10, 0x02): "AND",   # 32 位双字
}
CMP_TAIL_EXTRA = {0x00, 0x01, 0x02, 0x05, 0x06, 0x08, 0x0a, 0x0b}

# 比较族首字节取值（WPLSoft 内部码，非 DVP API 号）：e2/e4/e6/e9/ea。
# 除 CMP_NAMES 里已定名的组合外，其余同族字节头按未定名处理。
CMP_HEAD = {0xe2, 0xe4, 0xe6, 0xe9, 0xea}

def cmp_name(rec):
    """比较指令名；未定组合返回 None（由调用方按 ? 前缀处理）。"""
    return CMP_NAMES.get((rec[0], rec[1], rec[2]))

# 行尾/分隔/链标记（整体吞 5B，不输出；已定名：链尾标记 0b、连接 61 10、
# 分支尾 68 10 / 57 10、空链 5a、换行分隔 34/39）
MISC_SKIP = {
    0x0b: b'\x0b\x00\x00\x00\x00',
    0x5a: b'\x5a\x00\x00\x00\x00',
    0x34: b'\x34\x00\x00\x00\x00',
    0x39: b'\x39\x00\x00\x00\x00',
    0x61: b'\x61\x10\x00\x00\x00',
    0x68: b'\x68\x10\x00\x00\x00',
    0x57: b'\x57\x10\x00\x00\x00',
}

def _at_row_start(toks):
    """该条触点是否位于一个新分支的起点（决定 LD 还是 AND）。
    只有两种情况算起点：行首，或紧跟在 MPS/MRD/MPP/ORB/ANB 之后。
    注意不能把 LD/LDI 之后也算起点——那会把串联触点误改成起始触点。"""
    if not toks:
        return True
    return toks[-1].split()[0] in ('MPS', 'MRD', 'MPP', 'ORB', 'ANB')


def _to_loading(cp):
    """把串联触点改写成起始触点：ANDP→LDP、ANDF→LDF、ANI→LDI、AND→LD。"""
    for a, b in (('ANDP ', 'LDP '), ('ANDF ', 'LDF '), ('ANI ', 'LDI '), ('AND ', 'LD ')):
        if cp.startswith(a):
            return b + cp[len(a):]
    return cp


def disasm(seg, segno=0):
    """段数据区 → 行分组指令 token 流
    - 比较指令族 ?CMP（e2/e4/e6/e9 + 双操作数，指令名待对照，统一 ? 前缀）
    - 行尾/分隔记录整体吞 5B（0b/61 10/68 10/57 10/5a/34/39）
    - 段尾 0xFF 填充区截断
    - C 计数器类型 0x01 映射 "C"（值=编号）
    - 行头 5 字节 `12 05 E8 03 00` = LD M1000（0x03E8=1000，每网络首触点）
    - 主循环接入 decode_compact
    - 0x90 为操作数链连接记录（输出 |）
    """
    # 段尾 0xff 填充截断（连续 200B 以上）
    ff_at = seg.find(b'\xff' * 200)
    if ff_at > 0:
        seg = seg[:ff_at]
    marks = [i for i in range(len(seg) - 3) if seg[i] == 0x12 and seg[i+1] == 0x05 and seg[i+2] == 0xE8]
    # 段首「第一个 LD M1000 行头之前」的内容不能被丢：从 marks[0] 起切块会把每段
    # 首部整块静默吞掉（段首可能躺着功能指令）。
    if not marks or marks[0] != 0:
        marks.insert(0, 0)
    marks.append(len(seg))
    rows = []
    for li in range(len(marks) - 1):
        chunk = seg[marks[li]:marks[li+1]]
        i = 0
        toks = []
        if len(chunk) >= 5 and chunk[0] == 0x12 and chunk[1] == 0x05 and chunk[2] == 0xE8:
            toks.append("LD M1000")   # 行头 = 运转监视常开触点（0x03E8=1000）
            i = 5
        while i + 5 <= len(chunk):
            rec = chunk[i:i+5]
            b = rec[0]
            if b in (0x52, 0x00):
                # 全零 5 字节不能当 ANB：程序区里全零也用作记录间隔/填充，
                # 误读会整行冒出假 ANB。ANB 与填充的区分尚无判据，先保持「跳过」。
                i += 1
            elif b == 0x0b:
                # 0b 00 00 00 00 ＝ ORB（与指令表逐条对得上；紧随其后的全零记录是 ANB）
                toks.append('ORB'); i += 5
            elif b in (0x56, 0x59, 0x54):
                # 2026-11-05：栈指令记录是完整 5 字节（实测 `56 10 00 00 00` / `59 00 00 00 00`
                # / `54 10 00 00 00`），旧版 i += 1 把后 4 字节留进主循环：第 2 字节 0x10
                # 会被当作未知记录，尾字节不是 0x00 时只跳 1 字节 → 后续记录整体错位。
                toks.append({0x56: "MPS", 0x59: "MRD", 0x54: "MPP"}[b]); i += 5
            elif b == 0x90:
                # 0x90 记录携带 32 位数据的**高位字**（rec[4]=0x10 表示后面还有操作数）。
                # 高位字要并进前一个常数（如 K34463 + H1 = K99999），
                # 拆成两段会看错数量级。
                hi = rec[2] | (rec[3] << 8)
                m = re.match(r'^([KH])([0-9A-F]+)$', toks[-1]) if toks else None
                if hi and m:
                    kind, digits = m.group(1), m.group(2)
                    try:
                        # 2026-11-05：①H 型常数内部存的是十六进制，旧版按十进制 int() 解析
                        # 要么 ValueError（整条不拼）要么算错；②K 是 32 位有符号——高半字
                        # 全 1 时是负数，旧版无符号拼接把 K-200000 显示成 K4294767296。
                        val = int(digits, 16 if kind == 'H' else 10) + (hi << 16)
                        if kind == 'K' and val >= 0x80000000:
                            val -= 0x100000000
                        toks[-1] = f"H{format(val, 'X')}" if kind == 'H' else f"K{val}"
                        i += 5
                        continue
                    except ValueError:
                        pass
                toks.append(f"|H{hi}|" if hi else "|")
                i += 5
            elif b in (0x42, 0x44, 0x49):
                # 2026-11-05：0x44 / 0x49 是与 0x42 同形的功能指令记录——同为 5 字节，
                # rec[2] 是功能码，直接查同一张 CMD_MAP/GUESS_CMD（实证 9 条全部对上：
                #   44 10 5D 01 10 → 码 5D = DDRVI；44 10 00 D0 00 / 49 00 00 D0 00 → 码 00 = SET；
                #   49 00 29 00 10 → 码 29 = DMOV）。
                # 旧版不认这两种，尾字节 0x10 的记录落进 else 逐字节跳 → 整条指令名丢失且错位。
                if b == 0x42 and rec[2] == 0x18:
                    # 段首非程序记录（不在任何网络里、无操作数），不是指令，整体吞 5B
                    i += 5
                    continue
                toks.append(CMD_MAP.get(rec[2]) or guess_cmd(rec[2]) or f"??{rec[2]:02X}")
                i += 5
            else:
                op = decode_operand(rec)
                if op:
                    t, v = op
                    toks.append(f"{t}{disp_num(t, v)}")
                    i += 5
                else:
                    cname = cmp_name(rec) if rec[3] == 0x00 and rec[4] in (0x00, 0x10) else None
                    if cname:
                        toks.append(cname); i += 5
                    elif rec in MISC_SKIP.values():
                        i += 5
                    elif rec[0] in CMP_HEAD and rec[3] == 0x00 and rec[4] in (0x00, 0x10):
                        # 未定组合：先按关系码推断给出 ?CMP(关系)，推断不出才退回带字节头的占位
                        toks.append(guess_cmp(rec) or f"?CMP[{rec[0]:02x}{rec[1]:02x}{rec[2]:02x}]"); i += 5
                    else:
                        cp = decode_compact(rec)
                        if cp:
                            # LD/AND 由**行内位置**定，不由前缀定：MPS/MRD 之后的
                            # 第一条触点是 LDP/LDF/LD；前缀表把同一前缀一律标成
                            # ANDP/AND 会让整行前缀错。
                            if _at_row_start(toks):
                                cp = _to_loading(cp)
                            toks.append(cp)
                            i += 5
                        elif rec[1] == 0x15 and rec[0] in ROWIDX_PREFIX:
                            # 行号索引记录（14/16 + 15 行号 00 00）——仅 14/16 前缀
                            # 语义为程序行号索引，整体吞 5B，防内部字节误读为指令；
                            # 26/19 等前缀的 0x15 是 M 触点（decode_compact 已处理）
                            i += 5
                        else:
                            # 未识别记录若是标准 5 字节外形（尾字节 00），整吞，
                            # 不再逐字节跳：逐字节跳会让**后续所有记录整体错位**，
                            # 是指令序列与软件对不上的主要来源。
                            # 2026-11-05：同时记进台账 + 行内留痕，不再静默消失。
                            step = 5 if rec[4] == 0x00 else 1
                            UNKNOWN_RECS.append((segno, li, rec[:step].hex(' ')))
                            if step == 5:
                                toks.append(f"〔?{rec[0]:02x}{rec[1]:02x}{rec[2]:02x}〕")
                            i += step
        rows.append(" ".join(toks))
    return rows

def main():
    argv = sys.argv[1:]
    if not argv:
        print("用法: python dvp_decode.py <file.dvp> [-o 输出目录]")
        return
    path = argv[0]
    out_dir = None
    if "-o" in argv:
        out_dir = argv[argv.index("-o") + 1]

    data = read_bytes(path)
    text = data.decode("ascii", "replace")
    UNKNOWN_RECS.clear()
    lines = []

    # ---- 1. 结构 ----
    lines.append("=" * 60)
    lines.append("【文件结构】")
    lines.append("=" * 60)
    for m in re.finditer(r"Function=([A-Za-z ]+)", text):
        lines.append(f"  TypeBegin: Function={m.group(1)}")
    smt = find_all(text, "<SMT>")
    lines.append(f"  SMT 块数: {len(smt)} (程序段数)")

    # ---- 2. SegCmt 段落注释 ----
    seg_start = text.find("<SegCmt>")
    seg_end = text.find("</SegCmt>", seg_start)
    if seg_start >= 0:
        raw = data[seg_start + 9:seg_end]
        gbk = raw.decode("gbk", "replace")
        lines.append("")
        lines.append("=" * 60)
        lines.append("【段落注释 SegCmt】")
        lines.append("=" * 60)
        for m in re.finditer(r"<(\d+)><Cnt=(\d+)>", gbk):
            no = int(m.group(1)); cnt = int(m.group(2))
            cs = m.end()
            ce = gbk.find("<", cs)
            if ce < 0: ce = len(gbk)
            cmt = gbk[cs:ce].replace("\r", "").replace("\n", " ").strip()
            lines.append(f"  段[{no}] 行数={cnt}: {cmt}")

    # ---- 3. 设备注释（字节级 0x0A 分隔解析；按 0x00 找终止符会只解出一条）----
    dev_start = text.find("Function=Device Comment")
    if dev_start >= 0:
        db = text.find("<DataBegin>", dev_start) + len("<DataBegin>")
        de = text.find("<DataEnd>", db)
        seg = data[db:de] if de > db else data[db:db + 4000]
        lines.append("")
        lines.append("=" * 60)
        lines.append("【设备注释 Device Comment（全部）】")
        lines.append("=" * 60)
        n = 0
        for rec in seg.split(b"\x0A"):
            m = re.match(rb"^([A-Z]+)([0-9]+)\$&(.*)$", rec, re.S)
            if not m:
                continue
            cmt_b = m.group(3)
            try:
                cmt = cmt_b.decode("gbk").strip()
            except Exception:
                continue
            if not cmt:
                continue
            name = f"{m.group(1).decode()}{disp_num(m.group(1).decode(), int(m.group(2)))}"
            lines.append(f"  {name} = {cmt}")
            n += 1
        lines.append(f"  (共 {n} 条)")

    # ---- 4. 程序指令表 ----
    lines.append("")
    lines.append("=" * 60)
    lines.append("【程序指令表（行分组反汇编）】")
    lines.append("=" * 60)
    # fallback：部分 WPLSoft 版本存出的 .dvp 不写 <SMT> 分段标记，
    # 程序整块躺在 Initial Value 块的 <DataEnd> 与下一个 <TypeBegin> 之间
    # （末行是 END）。无标记时按整块反汇编。
    spans = []
    if smt:
        for si, pos in enumerate(smt):
            de = smt[si + 1] if si + 1 < len(smt) else text.find("<TypeBegin>", pos)
            spans.append((si, pos + 36, de))
    else:
        iv = text.find("Function=Initial Value")
        if iv >= 0:
            de0 = text.find("<DataEnd>", text.find("<DataBegin>", iv))
            nxt = text.find("<TypeBegin>", de0 + 1)
            if de0 > 0 and nxt > de0:
                spans.append((0, de0 + len("<DataEnd>"), nxt))
                lines.append("  (本工程无 <SMT> 分段标记，按 Initial Value 块后的整块数据反汇编)")
    for si, ds, de in spans:
        rows = disasm(data[ds:de], si)
        lines.append(f"--- 段{si} ---")
        for li, r in enumerate(rows):
            lines.append(f"  行{li}: {r}")

    # ---- 4.5 未识别记录台账 ----
    lines.append("")
    lines.append("=" * 60)
    lines.append("【未识别记录（认不出→已跳过；指令表里缺的东西在这里查）】")
    lines.append("=" * 60)
    if not UNKNOWN_RECS:
        lines.append("  无：本次解码的 5 字节记录全部落进已知指令/触点/操作数/填充。")
    else:
        agg = {}
        for sg, li, hx in UNKNOWN_RECS:
            agg.setdefault(hx, []).append((sg, li))
        lines.append(f"  共 {len(UNKNOWN_RECS)} 条（{len(agg)} 种字节形态）：")
        for hx, pos in sorted(agg.items(), key=lambda kv: -len(kv[1])):
            where = "、".join(f"段{a}行{b}" for a, b in pos[:6])
            more = f" 等 {len(pos)} 处" if len(pos) > 6 else ""
            lines.append(f"  ×{len(pos):<4} {hx:<15} 首见 {where}{more}")
        lines.append("  这些字节没被认成指令或触点，对应行里可能少了一条——拿字节形态去 WPLSoft")
        lines.append("  指令表对照；核出来再补 COMPACT_NAMES / CMD_MAP，别按猜测直接补。")

    # ---- 5. 推断对照表 ----
    lines.append("")
    lines.append("=" * 60)
    lines.append("【推断对照表（未经手册核对）】")
    lines.append("=" * 60)
    lines.append("  输出里 ? 开头的指令名＝推断，不是核对过的名字；拿它下结论前，先核台达指令表。")
    for code, (nm, why, conf) in sorted(GUESS_CMD.items()):
        lines.append(f"  功能码 {code:02X} → ?{nm}（把握 {conf}）：{why}")
    lines.append("  比较族 ?CMP(关系)：尾字节 00 = / 02 <> / 04 > / 06 < / 08 <= / 0a >=；08、0a 已核对，其余按步长 2 推断。")
    lines.append("  仍未定：以 ?? 开头的功能码（形态不足以推断）、以 ?CMP[ 开头的带码占位（关系码不在上表）。")

    report = "\n".join(lines)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "解码报告.md"), "w", encoding="utf-8") as f:
            f.write(report)
        print(f"报告已保存: {os.path.join(out_dir, '解码报告.md')}")
    else:
        print(report)

if __name__ == "__main__":
    main()

