# -*- coding: utf-8 -*-
"""
dvp_decode.py — 台达 WPLSoft/ISPSoft DVP 工程文件解码器（v3.1）

用法:
    python dvp_decode.py "D:\\xx\\眉笔l.dvp" [-o 报告输出目录]

功能:
  1. 文件结构（机型/TypeBegin块/SMT块分段）
  2. 段落注释 SegCmt（每段功能说明）
  3. 设备注释 Device Comment（I/O 定义全量，0x0A 分隔解析——v2 修复）
  4. 程序指令表（全 12 段，行分组反汇编；无 <SMT> 标记的工程自动走整块 fallback——v3.2）
  5. 生成 <输出目录>\解码报告.md（或 prints 到 stdout）

编码规则（v3，2026-09-16 签名字典法重注；已验证映射=本工程语义+设备注释闭环，
带 ? 的候选名均待 WPLSoft 对照，不冒充确认）:
  指令前缀 42 00 XX <A> <B>（5字节；A/B 多为 00，尾=10 时疑为链式/复数操作数指令）:
     00=SET, 07=RST, 03=TMR, 28=MOV（旧版误标 LD）, 3A=SUB, F6=DIV16,
     56=SFTL?（M M K K）, 60=ZRST?（M M 区间）, C4=MODRW?（K H D——站号/2001H/数据）,
     38=MUL16?, F4=CMP?（上/下吸位置对）, 3C=MULD?（速度×速比→频率）, 69=DBON（On 位判定，v14 更正）,
     40=INC?（计数）, 41=INC?, 54=ZCP?（K11111~K32767 区间）, F5/F7/39/3B=DIVK?（换算链）,
     29=DMOV?, 06=HS?, 0F=END?
  操作数前缀 80/86/88 0X（3 档，值=设备号直编码 LE）:
     02=D寄存器, 03=H立即数, 04=K立即数, 05=M位（86/88 多见于扩展区/变体）, 07=T定时器,
     01=C计数器, 0A=Y输出位（原误标系统位，见文末v4注释）
  行头 12 05 E8 03 00 XX（6字节，XX=行类型；XX=54 旧版误读为 MPP）
  行尾 TT 19 NN 00 00（待对照）; 空填充 52 00 00 00 00;
  操作数链连接 90 xx xx xx yy（5字节，输出 |）; 栈指令: 56=MPS, 59=MRD, 54=MPP

v2（2026-09-16）: 设备注释改 0x0A 分隔解析（旧版 find 0x00 只解出 1 条 → 1584 条全量）。
v3（2026-09-16）: 行头 6 字节整体吞噬；操作数前缀补 0x86/0x88；0x90 连接记录识别；
                 CMD_MAP 按"签名字典"重注（28=LD→MOV，LD@* 伪名消除）。
v4（2026-09-16）: 0x0A 类型由 系统位 改判为 **Y 输出位**——眉笔装盒机工程字节级验证：
                 (1) 实例值域 0~34 与设备注释 Y0~Y34 编号集合一一对应；
                 (2) 实例紧跟在 SET(42 00 00)/RST(42 00 07) 之后（输出线圈指令）；
                 (3) 段9 加料段 SET Y0夹料/Y1夹料伸缩/Y15夹料上下 语义闭环；
                 另识别紧凑位指令前缀：32 0a <n> = OUT Y{n}（段7/8/9 直出输出，
                 含 Y4主机运行/Y5输送带/Y6加料2电机/Y21报警黄灯）、
                 22 0a <n>/22 09 <n> = AND 触点读 Y/X、19/c9 前缀待对照；
                 紧凑位指令未接入 disasm（disasm 只解析 42 00 前缀），输出计数以字节级扫描为准。
v13（2026-10-06）: 操作数改按**软件显示口径**输出（disp_num）——H 立即数按十六进制
                 （MOV H86 D1120 / MODWR K1 H2001 D50 的字节值为 134/8193，已对拍）、
                 X/Y 按八进制（DVP 端子编号为八进制，无 X8/X9：字节 8→软件 X10、15→X17；
                 ZRST 区间 Y8~Y15 即软件 Y10~Y17）；设备注释的 X/Y 键同步换算。
                 M/T/C/D/K 仍为十进制。旧版按十进制打印 H/X/Y，是报告编号与
                 WPLSoft 显示"对不上"的根因（八进制 Y15 实为 Y17 一类）。
v14（2026-10-06）: 0x69 由误标的 LUT 改判为 **DBON**（On 位判定，API 44 的 32 位形态）——
                 依据 WPLSoft 梯形图截图（DBON K8M499 M802 D2040）+ 本机 WPLSoft 自带
                 Language\\API_Hint_Chs.txt 的 [API_44] 操作数说明（S=来源装置、D=存放判定结果
                 之装置、N=指定判定之位(自0开始编号)）。台达无 LUT 指令，旧标名与语义均错。
"""
import sys
import os
import re
import json

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
    """v13: 操作数按**软件显示口径**输出。
    文件内部一律存十进制数值，软件按设备类型换进制显示：
      H 立即数 → 十六进制（截图对拍：MOV H86 D1120 的字节值是 134=0x86；
                  MODWR K1 H2001 D50 的字节值是 8193=0x2001）；
      X / Y    → 八进制（DVP I/O 端子编号本就是八进制，无 X8/X9；字节值 8 = 软件 X10，
                  字节值 15 = 软件 X17；ZRST 区间 Y8~Y15 即软件 Y10~Y17）；
      M / T / C / D / K → 十进制（与软件一致）。
    按十进制打印 H/X/Y 是旧版编号"对不上软件"的根因。"""
    if t == "H":
        return format(val, "X")
    if t in ("X", "Y"):
        return format(val, "o")
    return str(val)

def decode_operand(rec):
    # 操作数类型前缀有 0x80 / 0x86 / 0x88 三档（疑似"页"变体：0x86 见于 M2000+ 区，
    # 0x88 见于 M40 等；值均为设备号直编码，直接显示编号即可）。
    # v17: 0x84 也是位组前缀（16 位组 K4M650），旧版只认 80/86/88 → 整条操作数被丢。
    if rec[0] not in (0x80, 0x84, 0x86, 0x88):
        return None
    sub = rec[1]
    val = rec[2] | (rec[3] << 8)
    # v5（2026-09-16）: 类型表补全 0x09=X 输入位（紧凑位指令 22 09 08 = AND X8 少盒检测，
    # 段7 报警段语义闭环）；0x0A 由 SYS 改判为 Y 输出位（眉笔装盒机工程验证）。
    # 0x01=C 计数器（值=编号，如 C1/C252；旧版映射 "C1>" 系拼接误读，v5 修正为 "C"）。
    # 注意：type=0x15 虽值域常与 M 编号重合，但经段8 行0（MOV K0..K31 D670 序列间
    # 40,41,42…71 完美递增）判定为梯形图行号索引而非 M 触点——不进入类型表。
    mapping = {0x02: "D", 0x03: "H", 0x04: "K", 0x05: "M", 0x07: "T",
               0x01: "C", 0x09: "X", 0x0A: "Y",
               # 2026-10-31 指令表截图实证：0x08 是**变址寄存器 E**（MOV D490 E3 / RST M620E3）
               0x08: "E", 0x85: "M"  # 0x85＝带变址的位组（RST M620E3 实证）
               }
    return (mapping.get(sub, f"80_{sub:02X}"), val)

# v5（2026-09-16）: 紧凑位指令前缀表（5 字节记录 = [cmd][type][val_lo][val_hi][00]，
# 触点/线圈类指令，无 42 00 前缀；全部实例见眉笔装盒机工程）。
# v7 补充（WPLSoft 指令表截图 000000-001027 权威配对）:
#   前缀 12 = 触点族（LD/AND 由行内位置界定），类型字节区分设备:
#     12 05 <n> = LD M<n>（段9 行0 LD M9/LD M20 → SET M706 加料信号）
#     12 09 <n> = LD X<n>（段9 行8 LD X13 → TMR T22）
#     12 07 <n> = AND T<n>（屏3 000186 AND T0）
#   前缀 32 = OUT；前缀 22 = AND 触点（22 09 08=AND X8 少盒检测）
#   前缀 c6 19 <n> = ANDF X<n>（屏3 000193/000205 两次复现，下降沿触点）
#   前缀 b4/b6/b9 19/09 <n> = ANDP X<n> 变体（屏3 000188/200/217 上升沿触点；
#     首字节疑为分支位置标记——MPS/MRD/MPP 后缀不同，待更多对照，保留 ?）
# 未定名前缀（均具触点/线圈特征，? 前缀待 WPLSoft 对照，不冒充确认）:
#   0x14/0x16/0x26/0x19/0xC9/0xB9/0xB2/0xC2/0xB4/0xC6/0xC4/0xB6
#   0x19 注意：段8 行0 尾 `19 05 47 00 00` 实为 MOV K31 的行号索引（行号 40+K 值，
#   40→71 与 MOV K0→K31 一一对应）；但段7/9 的 19 0A 0C=Y12、19 05 09=M9、
#   19 07 15=T21、19 05 72=M114、19 05 57 02=M599 均命中设备注释且位于指令流——
#   为触点。两义并存，显示时保留 ? 标记，需 WPLSoft 对照确认。
COMPACT_CMD = {
    # v7: 见上方 decode_compact 与 COMPACT_NAMES/COMPACT_Q 定义
}
# type 0x15 语义由前缀决定（v10 洞察）:
#   前缀 14/16 → 行号索引（段8 行0 40→71 递增序列）——主循环按 rec[1]==0x15 且前缀∈{14,16} 吞
#   前缀 26/19/其他 → M 触点（段9 26 15 09=M9 自动画面、段8 19 05 47 为行号争议）
# 故: 0x15 进类型表（M），但 decode_compact 只对「非行号前缀」应用 0x15 判定
COMPACT_TYPES = {0x05: "M", 0x09: "X", 0x0A: "Y",
                 0x07: "T", 0x01: "C1>", 0x02: "D", 0x03: "H", 0x04: "K",
                 0x19: "X", 0x15: "M",
                 # 2026-10-21: 0x1A = Y 页（B/C 系沿触点的 Y 页变体）。
                 # 实证 台达_RY 0.dvp 行11：`C4 1A 0E 00 00` = ANDF Y16，
                 # 紧接 `42 00 05 CNT C120 D1710`——每次喷胶1结束计一个数。
                 # 旧版无此页 → 整条沿触点被丢，计数器看上去"没有脉冲源"。
                 0x1A: "Y",
                 # 2026-11-21 WPLSoft 指令表实证（轴承飞料检测工程，段0）：
                 #   16 17 64 = AND T100（步 000093）、16 17 0f = AND T15（001952）、
                 #   16 17 0a = LD T10（002583）、16 17 0b = AND T11（002599）、
                 #   24 17 00 = LDI T0（001848）——0x17 页 = T（定时器触点）。
                 0x17: "T"}
# 行号索引前缀（保留吞 5B 语义）：14/16 为行号标记
ROWIDX_PREFIX = {0x14, 0x16}

# 2026-11-05：认不出的记录台账。disasm 每跳一条未识别记录就往这里记一笔
# （段号, 行号, 字节原文），main 末尾聚合成「未识别记录」一节。
# 这不是猜语义，是把「读不出来」变成看得见的账——用户能据此对照 WPLSoft 指令表。
UNKNOWN_RECS = []
CALIB = {}

# v7-v11: 触点/线圈指令前缀（WPLSoft 截图屏2/3 配对 + 段8 置位-复位对语义闭环）：
#   12 触点族（LD/AND/T 页）、32=OUT、22=AND/ANI、
# v11 最终裁决 B/C 系（屏3 + 段8 行4-8 双源验证）:
#   B 系（B4/B6/B2/B9）= ANDP（上升沿，置位侧）——屏3 ANDP X6→SET M1（000188）、
#     段8 行4 B2 M112(吸盒2位置)→SET Y9、段9 行4 B9 M116(放料)→SET Y13
#   C 系（C6/C9/C2/C4）= ANDF（下降沿，复位侧）——屏3 ANDF X6→RST M1（000193）、
#     段8 行4 C9 M112→RST Y9、段9 行4 C9 M116→RST Y13
#   同一设备 M 的"B→SET / C→RST"对=位置信号到达/离开，与屏3 启停段 X6 同构。
# 类型页: 0x05=M、0x09=X、0x0A=Y、0x19=X 脉冲页、0x15=M 触点（v10 前缀分流）
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
# B/C 系沿触点（v11 双源转正）：B=ANDP、C=ANDF，全类型页
# 2026-11-05：B 系补 0x07（T 页）/ 0x1A（Y 页）——C 系早就有 0x1A 的实证注释（C4 1A 0E = ANDF Y16），
# B 系漏页会让提升沿/下降沿触点整条消失；本机 16 份工程实测 B 系出现类型页 {05,07,09,15,17,19,1A}，
# 其中 0x17 页语义未定，暂不映射（宁缺不猜），其余补齐。
for _p in (0xB4, 0xB6, 0xB2, 0xB9):
    for _t in (0x05, 0x07, 0x09, 0x0A, 0x15, 0x19, 0x1A):
        COMPACT_NAMES[(_p, _t)] = "ANDP"
for _p in (0xC6, 0xC9, 0xC2, 0xC4):
    for _t in (0x05, 0x09, 0x0A, 0x15, 0x19, 0x1A):
        COMPACT_NAMES[(_p, _t)] = "ANDF"
# 未定名前缀（0x19 两义：行号索引变体 vs 触点）——按类型页分流：
#   19 07/0A/09（T/Y/X 类型页）= AND 触点（19 07 15=T21、19 0A 0C=Y12、19 09 25=X37）
#   19 05（M 类型页）两义：段9 19 05 09=M9 自动画面=触点；
#     段8 行0 尾 19 05 47(值71) 与行号序列 45/46 连续=行号索引（MOV K31 前）。
#     裁决: 值命中设备注释 M 表（M9/M114/M599/M1141 等）=触点 AND；否则=行号吞。
#     实现: decode_compact 内对 19 05 做值域检查（注释 M 表硬编码）。
COMPACT_Q = {}
# M2 页已知触点值（来自本工程设备注释 M 表 + 上下文验证）：
M19_CONTACT = {0, 1, 2, 4, 5, 6, 7, 9, 20, 21, 30, 46, 47, 48, 49, 56, 57, 58,
               59, 60, 61, 62, 72, 74, 80, 81, 82, 83, 84, 85, 86, 87, 88, 100,
               101, 102, 104, 105, 106, 107, 108, 109, 110, 112, 113, 114, 115,
               116, 117, 118, 119, 599, 1141}
COMPACT_NAMES[(0x19, 0x07)] = "AND"   # T 页触点
COMPACT_NAMES[(0x19, 0x0A)] = "AND"   # Y 页触点
COMPACT_NAMES[(0x19, 0x09)] = "AND"   # X 页触点
COMPACT_NAMES[(0x19, 0x05)] = "AND"   # M 页触点（decode_compact 内做 M19_CONTACT 值域检查）
# v15（2026-10-06）: 14/16 + 0x15 也是 **M 触点**（值=编号），不是行号索引——
#   实证：台达_RY 0.dvp 行10 字节 `12 05 F0 00 00 | 14 15 CA 00 00 | 12 09 0B 00 00`
#   对 WPLSoft 梯形图截图 = M1000·M240·**M202**·X13 串联（0xCA=202）；同文件另有
#   14/16+15 值 240/205/208/102~107 等，全部命中该工程的 M 装置。
#   旧版把这些整体吞 5B，导致触点丢失（本轮地图少了一个串联触点就是这么来的）。
#   眉笔工程observation「40→71 递增＝行号索引」据此存疑：那批若是 M40~M71 触点，
#   下次解眉笔时用 WPLSoft 指令表视图核一遍再定。
COMPACT_NAMES[(0x14, 0x15)] = "AND"
COMPACT_NAMES[(0x16, 0x15)] = "AND"
# v16（2026-10-06）: 0x24 + 0x19 也是触点（X 页），旧版无映射→逐字节跳过、把触点丢了。
#   实证：台达_RY 0.dvp 行10 `… 12 05 22 03 00 | 24 19 09 00 00 | 42 00 00 D0 00 | 80 05 66 00 00`
#   = M802 · **X11（测盒）** → SET M102——漏掉它就会把 M102 的条件看少一项。
COMPACT_NAMES[(0x24, 0x19)] = "AND"
# 2026-11-21 WPLSoft 指令表实证（轴承飞料检测工程 段0）：
#   0x17 页 = T（定时器触点）。前缀定「触点族」，LD/AND 由行内位置定（_at_row_start）：
#     16 17 64 → AND T100（000093）、16 17 0f → AND T15（001952）、
#     16 17 0a → LD T10（002583，行首）、16 17 0b → AND T11（002599）；
#     24 17 00 → LDI T0（001848，行首；中段则为 ANI）。
COMPACT_NAMES[(0x16, 0x17)] = "AND"
COMPACT_NAMES[(0x24, 0x17)] = "ANI"
# 0x1A = Y 页（脉冲触点页），与 0x0A 同族；16 1a 04 → AND Y4（001900/002655，行首则 LD）
COMPACT_NAMES[(0x16, 0x1A)] = "AND"
# 0x29 = 取反触点族（位取反后串入）：29 0a 04 → ANI Y4（002660）、
# 29 05 09 → LDI M9（003001，行首经 _to_loading 转 LDI）
COMPACT_NAMES[(0x29, 0x0A)] = "ANI"
COMPACT_NAMES[(0x29, 0x05)] = "ANI"
# 2026-11-21: 同一前缀换设备页——op 属于前缀、设备页属于 type 字节。
#   0x24 系在 0x19（X 页）已实证为 AND；0x15(M)／0x1A(Y) 是同一前缀的相邻设备页，
#   0x26 系同理（0x19/0x15 已实证 AND，0x1A 是 Y 页）。按「前缀判 op」展开，不新增结论。
COMPACT_NAMES[(0x24, 0x15)] = "AND"
COMPACT_NAMES[(0x24, 0x1A)] = "AND"
COMPACT_NAMES[(0x26, 0x1A)] = "AND"

def decode_compact(rec):
    """v11: 紧凑位指令 5 字节记录（触点/线圈），不在 42 00 前缀体系内。
    名字优先级: COMPACT_NAMES（截图配对 + 语义闭环转正）> COMPACT_Q（? 待对照）。
    0x15 类型仅在前缀非行号索引时参与判定（否则由主循环吞 5B 为行号）。
    0x19+0x05 类型页做值域检查（M19_CONTACT 表内=触点，否则=行号索引）。
    仅当 cmd 已知、type 在表内、尾部为 00 时判定，避免误吞其它未知记录。"""
    if rec[1] not in COMPACT_TYPES:
        return None
    if rec[4] != 0x00:
        return None
    # v15: 14/16 + 0x15 已确认是 M 触点（见 COMPACT_NAMES 注释），不再当行号索引吞掉
    # if rec[1] == 0x15 and rec[0] in ROWIDX_PREFIX:
    #     return None
    val = rec[2] | (rec[3] << 8)
    name = COMPACT_NAMES.get((rec[0], rec[1])) or COMPACT_Q.get(rec[0])
    if name is None:
        return None
    # 0x19+0x05：一律当 M 触点。旧版用硬编码 M19_CONTACT 值域表挡"行号索引"，
    # 但表里漏了工程里真实用到的 M（实测 M185 被吞 → 报告的 AND M185 丢失）。
    # 行号索引的真实前缀是 14/16（见 ROWIDX_PREFIX），不需要在 19 页上再挡。
    t = COMPACT_TYPES[rec[1]]
    # 2026-11-21 实证（双吸火花塞：把 M1000 常开改成常闭后存盘，前缀 12 05 E8 03 00 → 22 05 E8 03 00）：
    # 触点前缀高 4 位定“是否取反”——0x1x 常开族、0x2x 取反族、0x3x 输出族。
    # 取反不看行内位置；位置只决定 LD/AND（_at_row_start + _to_loading 负责）。
    hi = rec[0] & 0xF0
    flip = {("AND", "ANI"), ("LD", "LDI"), ("ANDP", "ANDF"), ("ANDF", "ANDP")}
    if hi == 0x20:
        for a, b in flip:
            if name == a:
                name = b
                break
    elif hi == 0x10:
        for a, b in flip:
            if name == b:
                name = a
                break
    if t == "C1>":
        return f"{name} C{val}"
    return f"{name} {t}{disp_num(t, val)}"

CMD_MAP = {
    # 已由本工程语义验证的映射（2026-09-16 签名字典法；v7 用 WPLSoft 截图截图4 转正 DMOV；
    # v12 全部剩余项转正——台达 DVP 指令语义闭环 + WPLSoft 指令表权威）：
    0x00: "SET", 0x07: "RST", 0x03: "TMR", 0x3A: "SUB",
    0x28: "MOV",   # 54 条，模式 K→D / H→D / D→D（旧版误标 LD）
    0x56: "SFTLP",  # 2026-10-31 WPLSoft 截图实证：M289 M290 K3 K1 → 软件显示 SFTLP（脉冲型移位寄存器），旧版少写 P
    0x60: "ZRST",  # 8 条，M M 区间——区域清零（段6/8 区间复位）
    0xC4: "MODWR",  # 1 条，K H D（截图2 000077 MODWR K1 H2001 D50 ✓ 转正——MODBUS 写变频站 2001H）
    0x38: "MUL16",  # 2 条，D K D（段11 锁机换算链 MUL16 D471 K1 D471，与 0xF4 同指令不同操作数形态）
    0xF6: "DIV16",  # 3 条，D K D（÷100 换算，已验证；截图3 000239 DIV16 D3622 K100 D3622 ✓）
    0xF4: "MUL16",  # 3 条，D D D（截图3 000232 MUL16 D3008 D3610 D3622 ✓ 转正：速度换算链）
    0x3C: "DMUL",  # 2026-10-31 WPLSoft 截图实证（Dvp0）：DMUL C252 K1 D2344；旧标 MUL 少写 D
    # v19（2026-10-07，本机「进料叠料4伺服」工程实证）——旧版把这一族一律标 DIV，
    # 实测至少一半方向是反的（长度换算链会整条读错）：
    0x39: "ADD",   # D2680 = D2340 + D2360，装置注释写明「一加二段拉膜长度」= 两段拉膜脉冲相加
    0x3B: "DIV",   # D2510 = 包装长度 ÷ 物料长度（每袋料数）；D2330 = 包装长度 ÷ 第一段长度
    0xF5: "MUL",   # D2036 = D2032 × 314（直径→周长）；D220 = D1030 × D2010（脉冲→长度）
    0xF7: "DIV",   # D2010 = D2036 ÷ D2030（周长÷速比=一圈距离）；D550 = K600000 ÷ D60（速度）
    0x3D: "MUL",   # D2324 = D2320 × 200000（长度→脉冲）；D498 = D506 × 33
    0x3F: "DIV",   # D2340 = D2324 ÷ D2010（脉冲数）；D2520 = D2510 ÷ 2；D2090 = D2080 ÷ D2010
    # 同一乘/除有两个功能码（0xF5/0x3D 都是乘、0xF7/0x3F 都是除）——按本工程数据判为
    # 「同一指令的两种操作数页（16 位/32 位或常数/寄存器形态）」，WPLSoft 里的确切助记
    # （MUL/DMUL、DIV/DDIV）待指令表截图核一次；语义方向已由长度/速度换算链物理量验证。
    0x0F: "END",   # 程序结束标记
    0x41: "INC", 0x40: "INC",   # 单 D 操作数递增计数（D30 缺书、D427/D428 走盒、D32 工位）
    0x54: "ZCP",   # 3 操作数 K K D：区间比较（K11111~K32767 vs D80）——DVP ZCP 指令
    0x06: "DCNT",  # C K（C252 高速计数器设定；截图4 DCNT C252 K8 权威——参数 K8 vs 字节 K0 为取模偏移）
    # 2026-10-21: 0x05 = CNT（16 位计数器，API 05）。实证 台达_RY 0.dvp：
    #   `42 00 05 00 00 | 80 01 78 00 00(C120) | 80 02 AE 06 00(D1710)`
    #   前一记录是 `C4 1A 0E 00 00`(ANDF Y16)，即每次喷胶1结束计一个数。
    0x05: "CNT",
    0x29: "DMOV",   # 32 位复制（C252→D100 编码器值；截图4 三次标注 DMOV C252 D100 ✓ 转正）
    0x68: "BON",   # On 位判定（API 44 的 16 位形态）：字节实证
                   #   `42 00 68 | 84 05 8A 02 (=K4M650) | 80 05 9E 02 (=M670) | 80 02 FE 07 (=D2046)`
                   #   = BON K4M650 M670 D2046；位组前缀 0x84=16 位、0x88=32 位。
                   #   旧版无此映射 → 整条被吞成 ??68、还丢掉位组操作数（v17 更正）。
    0x69: "DBON",  # On 位判定（API 44 的 32 位形态）= WPLSoft 指令表截图核对（DBON K8M499 M802 D2040：
                   #   S=来源位组 K8M499（M499 起 32 位）、D=结果位 M802、N=位号（来自 D2040，0 起算）。
                   #   旧版误标 LUT/工位延时查表——台达无 LUT 指令，语义也对不上，v14 更正）
}

# ── 推断映射（2026-10-31，用户口径「直接猜码」）──
# 这些**不是**核对过的名字：只按「操作数形态 + 同族相邻码 + 本机工程语义」推断，
# 输出一律带 `?` 前缀（如 ?DRVI），报告末尾附依据表。核对手册后应逐条转正或改判。
GUESS_CMD = {
    0x3E: ("DIV", "3 操作数 D K D；WPLSoft 截图实证（Dvp0 行2：DIV D2344 K1 D2340，紧跟 DMUL C252 K1 D2344）→ 16 位除（与 0x3B 同名的另一形态）", "已核"),
    0x0D: ("PLS", "单一位操作数（M2003/M2004/M2005），紧跟 RST/AND 序列、靠后续触点取一个扫描周期的脉冲；与 0x00=SET（持续置位）用法区分", "中"),
    0x1A: ("RST", "带位组/变址的操作数（M620E3）；WPLSoft 指令表实证：Dvp0 步 000902 `RST M620E3` 对应本码——与 0x07=RST 是同一条指令的位组变址形态", "已核"),
    0x94: ("ALT", "仅 1 个位操作数；WPLSoft 截图实证（Dvp0 行 136：ALT M501，T210+Y2 驱动，随后 M501 常闭驱动 Y25）→ 交替输出", "已核"),
    0x8D: ("DABSD", "4 操作数 D|D|M|K；WPLSoft 截图实证（Dvp0 行 33：DABSD D2000 D2340 M200 K35，注释「取袋吸气开/吸袋」）→ 绝对位置检出，不是高速计数置位", "已核"),
    0x8C: ("DABSR", "4 操作数 D|C|M|K（D500 C1 M100 K30 / D2100 C2 M180 K10）：与已核 0x8D=DABSD 同族，参数换成计数器 → 绝对位置检出复位", "中"),
    0x8A: ("SER", "4 操作数 D540|D80|D560|K10；WPLSoft 截图实证（双吸火花塞行 286：SER D540 D80 D560 K10，T40 定时后执行、结果 D560 再比较）→ 数据检索", "已核"),
    0x5A: ("WSFLP", "4 操作数 D80|D540|K10|K1；WPLSoft 截图实证（同行 288：WSFLP D80 D540 K10 K1，D80 是 RAND 产生的随机工位号）→ 位移写入", "已核"),
    0x5D: ("DDRVI", "4 操作数 K|K|Y|Y（K3392|H3 即 32 位常数 + 速度 + Y0 + Y1）；与截图图1 的 DDRVI K-9999999 K-2000 Y0 Y1 形态一致 → 32 位相对定位", "中"),
    0x5F: ("DDRVA", "4 操作数 K0|D2300|Y0|Y1；WPLSoft 截图实证（Dvp0 行 234：DDRVA K0 D2300 Y0 Y1「拉链合速度」；同段还有 DDRVA D2334 D2308 Y0 Y1）→ 32 位绝对定位", "已核"),
    # 2026-10-31 第二轮：按网络前后逻辑补判（D160/D545/D180 数据流、K34463|H1=99999 限幅常数）
    0x87: ("DPLSR", "4 操作数 D|K99999|D|Y；WPLSoft 截图实证（AL26010 行 69：DPLSR D190 K99999 D1343 Y0，注释「第一组脉冲 CH0(Y0,Y1) 输出,加」）→ 带加减速脉冲输出", "已核"),
    0xAB: ("DVSPO", "4 操作数 D160|D545|D180|Y0；WPLSoft 截图实证（X7 急停行 → DVSPO D160 D545 D180 Y0，逐字一致；同工程两处）→ 变速脉冲输出", "已核"),
    0xF1: ("DMOVR", "3 操作数 32 位浮点常数|D；WPLSoft 截图实证（AL26010 行 560：DMOVR F600.000 D580、DMOVR F60.000 D582）→ 32 位浮点传送，旧标 DMOV 是误读", "已核"),
    0x72: ("FLT", "2 操作数 D|D；WPLSoft 截图实证（AL26010 行 549：FLT D84 D94「每次时长」），紧接 DEDIV/DEMUL 浮点链 → 整数转浮点", "已核"),
    0x22: ("INT", "2 操作数 D|D；WPLSoft 截图实证（AL26010 行 552：INT D102 D104），在浮点链末端 → 浮点转整数", "已核"),
    0x83: ("DPLSY", "3 操作数 D472|K0|Y2；WPLSoft 截图实证（收膜步进 M36+M1000 → DPLSY D472 K0 Y2）→ 32 位脉冲输出", "已核"),
    0x1C: ("FEND", "无操作数；WPLSoft 截图实证（AL26010 段0 末尾）：位于温差比较触点（D922 D502）之后、中断程序 M1000 常闭驱动 Y100 之前 → FEND（第一扫描结束）", "已核"),
    0x16: ("IRET", "无操作数；WPLSoft 截图实证（AL26010 段0 末尾）：位于 Y100 输出之后、END 之前 → 中断返回 IRET（不是 FEND）", "已核"),
    0x4C: ("MODRW", "5 操作数 K K K D K；WPLSoft 截图实证（K10 K16 K20 D2000 K12 与软件逐字一致，同段 6 条）→ MODBUS 多寄存器读写", "已核"),
    0x71: ("DSQR", "2 操作数 D|D；WPLSoft 截图实证（AL26010 行 162：DSQR D320 D312）→ 32 位平方根，旧标 XCH 是误读", "已核"),
    0x2E: ("BMOV", "3 操作数 D D K；WPLSoft 截图实证（AL26010 段0 行3：D1296 D750 K12、D1296 D780 K2、D1296 D850 K2、D1296 D880 K1 四条，软件均显示 BMOV）→ 块传送，不是区间比较", "已核"),
}
GUESS_CMP_REL = {
    0x00: "=", 0x02: "<>", 0x04: ">", 0x06: "<", 0x08: "<=", 0x0a: ">=",
    # 奇数尾字节按「OR 逻辑 + 前一档关系」推断（0x0b 实测出现在 C252|K50 这类双操作数比较上）
    0x01: "OR=", 0x03: "OR<>", 0x05: "OR>", 0x07: "OR<", 0x09: "OR<=", 0x0b: "OR>=",
    # 0x1f：实测全部是「定时器当前值 vs 常数/寄存器」（T41 K30 / T76 K5 / T11 K50 / T12 D477），
    # 后接 RST/SET/OUT 或 ANI 判断，按"到达设定值"判 >=
    0x1f: ">=",
}

def guess_cmd(code):
    g = GUESS_CMD.get(code)
    if not g or g[0] == '??':
        return None
    # 把握＝已核/中 的当已定用（不带 ?）；只有"低"仍带 ? 提示存疑
    return g[0] if g[2] in ('已核', '中') else f"?{g[0]}"

def guess_cmp(rec):
    """比较族：关系码已定（08、0a 截图转正，其余按步长 2 推），逻辑连接（LD/AND/OR）由网络位置决定、不逐条标。
    输出 CMP(关系) —— 不带 ?，关系本身当已定用；要区分 LD/AND 时看它在网络里的位置。"""
    rel = GUESS_CMP_REL.get(rec[2])
    if not rel:
        return None
    return f"CMP({rel})"

# 未定名功能码（本机 4 伺服工程实测操作数形态，等 WPLSoft 指令表对照后再定名，不冒充）：
#   0x5D / 0x5F 4 操作数（脉冲数、频率、脉冲输出 Y、方向 Y）——脉冲定位输出族。
#       0x5F 只出现在 Y0 且脉冲数取 D2340/D2660（16 位量级）；0x5D 出现在 Y0/Y2/Y3，
#       第一操作数可为 32 位常数（K200000000＝长跑到色标中断截停）或 D 寄存器对
#       → 判为 16 位/32 位两种形态（DRVI/DDRVI 一族，相对/绝对未定）。功能码第 4 字节 = 0x01。
#   0x83        3 操作数（频率、K0、Y输出）——变速/连续脉冲输出（K0＝不计数连续走），点动段用。
#   0x0D        首操作数为位（M4000/M4001/M4002），其后跟一条比较记录 + 位/常数（仅锁机段出现）。
#   0x1C        无操作数，夹在 RST Y 与下一个 LD M 之间（网络/分支标记类）。
#   0x16        无操作数，程序末尾 END 之前（疑 FEND）。
#   0x18        出现在 <SMT> 段头正前方，非程序区记录，不要当指令。

# 比较指令族（v7/v8，2026-09-16）: [e2/e4/e6/e9][00/10][尾][00][00/10] + 操作数对。
# v7 用 WPLSoft 指令表截图转录（000000-001027，2026-09-02 用户提供）转正；
# v8 用段0 行2 截图2 对拍裁定 e6 10 08 = AND<=（000042 AND<= D412 K5 两次转录权威），
#   修正 v7 误标 OR<=。0b 00 00 00 00 为 ORB/ANB 块连接（屏4 000327/000328）。
# 已定名（操作数对匹配度闭环）:
#   e4 10 0a + (C1, D500) = LD>= C1 D500   （段5 000302；段0 000014 截图标 AND>=，栈首/块中语境差）
#   e2 00 08 + (C1, D501) = AND<= C1 D501  （000307）
#   e6 10 0a + (C1, D500) = LD<= C1 D500   （000312）
#   e6 10 08 + (C1, D501) = AND<= C1 D501  （000317 转录 OR<= 存疑「看不清」；段0 000042 AND<= 权威→AND<=）
#   e4 10 02 + (D500, D501) = AND（32 位双字）——屏4-10 全部 30 个工位块权威标注
#     "AND D5xx"（如 000322 AND D500、000874 AND D538），v9 转正
#   e9 00 0a + (D, D)     = AND>=          （000025 AND>= D411 D413）
# 注意: 同一码在逻辑栈首/块中语境截图可能显示 LD/AND 差异；本实现按截图最高频定名，
# 已知偏差以注释标注，不冒充。
CMP_NAMES = {
    (0xe4, 0x10, 0x0a): "LD>=",
    (0xe2, 0x00, 0x08): "AND<=",
    (0xe6, 0x10, 0x0a): "LD<=",
    (0xe6, 0x10, 0x08): "AND<=",
    (0xe9, 0x00, 0x0a): "AND>=",
    (0xe9, 0x00, 0x08): "AND<=",
    (0xe2, 0x00, 0x0a): "AND<=",
    (0xe4, 0x10, 0x02): "AND",   # 32 位双字（v9 转正，屏4-10 30 工位块权威）
}
CMP_TAIL_EXTRA = {0x00, 0x01, 0x02, 0x05, 0x06, 0x08, 0x0a, 0x0b}

# 比较族首字节取值（WPLSoft 内部码，非 DVP API 号）：本机工程实测出现 e2/e4/e6/e9/ea。
# 除 CMP_NAMES 里已定名的 8 种组合外，其余同族字节头按未定名处理（见 disasm v20）。
CMP_HEAD = {0xe2, 0xe4, 0xe6, 0xe9, 0xea}

def cmp_name(rec):
    """比较指令名；未定组合返回 None（由调用方按 ? 前缀处理）。"""
    return CMP_NAMES.get((rec[0], rec[1], rec[2]))

# 行尾/分隔/链标记（整体吞 5B，不输出；v6 定名：链尾标记 0b、连接 61 10、
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
    """该条触点是否位于一个新分支的起点（决定 LD/LDI 还是 AND/ANI）。
    算起点：行首、紧跟在 MPS/MRD/MPP/ORB/ANB 之后、或紧跟行头 LD M1000 之后。
    注意不能把任意 LD/LDI 之后也算起点——那会把串联触点误改成起始触点。"""
    if not toks:
        return True
    last = toks[-1]
    if last == 'LD M1000':
        return True
    return last.split()[0] in ('MPS', 'MRD', 'MPP', 'ORB', 'ANB')


def _to_loading(cp):
    """把串联触点改写成起始触点：ANDP→LDP、ANDF→LDF、ANI→LDI、AND→LD。"""
    for a, b in (('ANDP ', 'LDP '), ('ANDF ', 'LDF '), ('ANI ', 'LDI '), ('AND ', 'LD ')):
        if cp.startswith(a):
            return b + cp[len(a):]
    return cp


def disasm(seg, segno=0, collect=None, calib=None):
    """段数据区 → 行分组指令 token 流
    v6（2026-09-16）: ①比较指令族 ?CMP（e2/e4/e6/e9 + 双操作数，语义闭环但指令名
    待对照，统一 ? 前缀）；②行尾/分隔记录整体吞 5B（0b/61 10/68 10/57 10/5a/34/39）；
    ③段尾 0xFF 填充区截断（段11 尾 7000+ 条 ff，旧版逐字节跳过性能低且无意义）；
    ④C 计数器类型 0x01 映射 "C"（值=编号）。
    v5（2026-09-16）：行头实为 5 字节 `12 05 E8 03 00` = **LD M1000**（0x03E8=1000，
    运转监视常开触点，每网络首触点；旧版误当 6 字节行头吞噬，导致行头后首个
    紧凑触点被吞又错位——现在明确为 LD M1000 并输出）；主循环接入 decode_compact。
    v3（2026-09-16）：①行头按 6 字节吞噬（v5 修正）；②操作数前缀补 0x86/0x88；
    ③0x90 为操作数链连接记录（输出 |）。
    """
    # 段尾 0xff 填充截断（连续 200B 以上）
    ff_at = seg.find(b'\xff' * 200)
    if ff_at > 0:
        seg = seg[:ff_at]
    marks = [i for i in range(len(seg) - 3) if seg[i] == 0x12 and seg[i+1] == 0x05 and seg[i+2] == 0xE8]
    # v18（2026-10-07）: 段首「第一个 LD M1000 行头之前」的内容不能被丢。旧版从 marks[0]
    # 起切块，等于把每段的第一行之前整块静默吞掉。实测本工程段[5]启停 前区 3144 字节里
    # 躺着 48 条功能指令（占全程序功能指令的 1/4），整段首部消失却毫无提示。
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
                # 2026-11-01 试过「全零 5 字节＝ANB」，实测失败：程序区里全零也用作
                # 记录间隔/填充，一改成 ANB 整行冒出几十个假 ANB（Dvp0 行0/行12）。
                # ANB 与填充的区分尚无判据，先保持「跳过」，等更多样本再定。
                i += 1
            elif b == 0x0b:
                # 0b 00 00 00 00 ＝ ORB（Dvp0 002501 与指令表逐条对上；紧随其后的全零记录是 ANB）
                toks.append('ORB'); i += 5
            elif b in (0x56, 0x59, 0x54):
                # 2026-11-05：栈指令记录是完整 5 字节（实测 `56 10 00 00 00` / `59 00 00 00 00`
                # / `54 10 00 00 00`），旧版 i += 1 把后 4 字节留进主循环：第 2 字节 0x10
                # 会被当作未知记录，尾字节不是 0x00 时只跳 1 字节 → 后续记录整体错位。
                toks.append({0x56: "MPS", 0x59: "MRD", 0x54: "MPP"}[b]); i += 5
            elif b == 0x90:
                # 0x90 记录携带 32 位数据的**高位字**（rec[4]=0x10 表示后面还有操作数）。
                # 2026-10-31：高位字直接并进前一个常数——`K34463` + `H1` 实际是 K99999
                # （软件截图 DPLSR D190 K99999 D1343 Y0，若拆成两段会看错 6.5 万倍）。
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
                name = _cal_name(calib, f"cmd:{rec[2]:02X}") or CMD_MAP.get(rec[2]) or guess_cmd(rec[2]) or f"??{rec[2]:02X}"
                _args = []
                # 2026-11-21（WPLSoft 指令表实证，轴承飞料检测工程）：功能指令 = 一个 42/44/49 格
                # 加后面若干"操作数格"（5 字节，首字节 0x80；块内空槽为全 0 格）。
                # 旧版只吃 5 字节，操作数格被主循环当独立记录再扫一遍——于是操作数、栈指令、
                # 触点互相插队，整行顺序错乱（段0 逐条比对：对上 255/885）。
                j = i + 5
                while j + 5 <= len(chunk):
                    nxt = chunk[j:j+5]
                    if nxt[0] == 0x90:
                        # 2026-11-21 实证（双吸火花塞工程 ADD D524 K880 D528）：
                        # `90 xx 00 00 10` 是操作数之间的续接标记，不是 32 位常数的高位字。
                        j += 5
                        continue
                    if nxt[0] == 0x80:
                        opnd = decode_operand(nxt)
                        if opnd:
                            t, v = opnd
                            _args.append(f"{t}{disp_num(t, v)}")
                            j += 5
                            continue
                    if nxt == b"\x00\x00\x00\x00\x00":
                        j += 5
                        continue
                    break
                toks.append(" ".join([name] + _args))
                i = j
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
                            # 2026-10-31：LD/AND 由**行内位置**定，不由前缀定。
                            # WPLSoft 指令表实证：MPS/MRD 之后的第一条触点是 LDP/LDF/LD，
                            # 前缀表把同一前缀一律标成 ANDP/AND 导致整行前缀错。
                            if _at_row_start(toks):
                                cp = _to_loading(cp)
                            toks.append(cp)
                            i += 5
                        elif rec[1] == 0x15 and rec[0] in ROWIDX_PREFIX:
                            # 行号索引记录（14/16 + 15 行号 00 00）——仅 14/16 前缀
                            # 语义为程序行号索引（段8 行0 40→71 递增），整体吞 5B，
                            # 防内部字节误判为指令；26/19 等前缀的 0x15 是 M 触点
                            # （decode_compact 已按 COMPACT_NAMES 处理）
                            i += 5
                        else:
                            # 2026-10-31：未识别记录若是标准 5 字节外形（尾字节 00），整吞，
                            # 不再逐字节跳。逐字节跳会让**后续所有记录整体错位**——这是报告里
                            # 指令序列与软件对不上的最大一处来源（实测：一条 24 15 未映射，
                            # 后面四条的网格全偏）。
                            # 2026-11-05：同时记进台账，报告末尾列清单（不再静默消失）。
                            step = 5 if rec[4] == 0x00 else 1
                            UNKNOWN_RECS.append((segno, li, rec[:step].hex(' ')))
                            if step == 5:
                                # 行内留痕：这一行这里有一条没读懂的东西（不是静默丢掉）；校准表里有名字就用名字
                                _hx = rec[:step].hex(' ')
                                toks.append(_cal_name(calib, _hx) or f"〔?{rec[0]:02x}{rec[1]:02x}{rec[2]:02x}〕")
                            i += step
        rows.append(" ".join(toks))
        if collect is not None:
            collect.append((segno, li, list(toks)))
    return rows


# ---- 指令流结构化（--json 输出给梯形图用；与报告同一份 token） ----
_OPERAND_RE = re.compile(r'^(?:K-?\d+|H[0-9A-F]+|[DXMYTCSV]\d+(?:\.\d+)?|F-?[\d.]+)$')

def _cal_name(calib, key):
    v = (calib or {}).get(key)
    if isinstance(v, dict):
        v = v.get("name")
    return v


def to_insts(toks):
    """token 串 → [{op,args}]：操作数挂到前一条指令上；| 分隔符丢弃。"""
    insts = []
    for t in toks:
        if t == '|' or (t.startswith('|H') and t.endswith('|')):
            continue
        if t in ('MPS', 'MRD', 'MPP', 'ORB', 'ANB') or t.startswith('〔?') or t.startswith('?CMP') or t.startswith('??'):
            insts.append({'op': t, 'args': []})
            continue
        if ' ' in t:
            op, _, arg = t.partition(' ')
            insts.append({'op': op, 'args': [arg]})
            continue
        if _OPERAND_RE.match(t):
            if insts:
                insts[-1]['args'].append(t)
            continue
        insts.append({'op': t, 'args': []})
    return insts

def main():
    argv = sys.argv[1:]
    if not argv:
        print("用法: python dvp_decode.py <file.dvp> [-o 输出目录]")
        return
    path = argv[0]
    out_dir = None
    json_path = argv[argv.index("--json") + 1] if "--json" in argv else None
    calib_path = argv[argv.index("--calib") + 1] if "--calib" in argv else None
    if "-o" in argv:
        out_dir = argv[argv.index("-o") + 1]

    data = read_bytes(path)
    text = data.decode("ascii", "replace")
    UNKNOWN_RECS.clear()
    if calib_path and os.path.exists(calib_path):
        try:
            with open(calib_path, encoding="utf-8") as f:
                CALIB.update((json.load(f).get("dvp") or {}))
        except Exception:
            pass
    lines = []
    insts_out = []

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

    # ---- 3. 设备注释（v2 2026-09-16：字节级 0x0A 分隔解析；旧算法找 0x00 当注释
    # 终止符是错的——注释文本直接以 0x0A 结尾，导致旧版只解出 D3650 一条）----
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
    # v3.2 fallback：部分 WPLSoft 版本存出的 .dvp 不写 <SMT> 分段标记，
    # 程序整块躺在 Initial Value 块的 <DataEnd> 与下一个 <TypeBegin> 之间
    # （AL26010最终版.dvp 实证：38 行，末行 END）。无标记时按整块反汇编。
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
        rows = disasm(data[ds:de], si, insts_out, CALIB)
        lines.append(f"--- 段{si} ---")
        for li, r in enumerate(rows):
            lines.append(f"  行{li}: {r}")

    # ---- 4.5 未识别记录台账 ----    lines.append("")
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
    lines.append("  比较族 ?CMP(关系)：尾字节 00 = / 02 <> / 04 > / 06 < / 08 <= / 0a >=；08、0a 已由截图转正，其余按步长 2 推断。")
    lines.append("  仍未定：以 ?? 开头的功能码（形态不足以推断）、以 ?CMP[ 开头的带码占位（关系码不在上表）。")

    if json_path:
        os.makedirs(os.path.dirname(os.path.abspath(json_path)), exist_ok=True)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump([{"seg": sg, "line": li, "insts": to_insts(toks)} for sg, li, toks in insts_out], f, ensure_ascii=False)

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

