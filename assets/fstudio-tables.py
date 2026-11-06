# -*- coding: utf-8 -*-
"""fstudio-tables.py —— FStudio(.fsprj) 工程出结构化表（画面/控件）
用法: python fstudio-tables.py <工程目录或 .fsprj> [输出目录]
工程目录须含 HMI/System/fs2.s3db；输出 画面.tsv / 控件.tsv / 变量.tsv。
"""
import os
import sqlite3
import sys

def main():
    if len(sys.argv) < 2:
        print("用法: python fstudio-tables.py <工程目录或 .fsprj> [输出目录]")
        return 2
    src = os.path.abspath(sys.argv[1])
    root = os.path.dirname(src) if src.lower().endswith('.fsprj') else src
    db = os.path.join(root, 'HMI', 'System', 'fs2.s3db')
    if not os.path.exists(db):
        print(f"找不到 {db}（FStudio 工程结构不符）")
        return 3
    out = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(root, '解码归档', os.path.basename(root))
    os.makedirs(out, exist_ok=True)

    c = sqlite3.connect(db)
    def rows(sql):
        try:
            return c.execute(sql).fetchall()
        except Exception:
            return []

    windows = rows("select WindowId, Name, FullName, WindowType, OrderId from WindowsInfo order by OrderId")
    comps = rows("select ComponentId, Name, GraphicType, WindowId from OperationRecordComponent order by WindowId, Id")
    tags = rows("select * from VariableTagDetailsV2 limit 0")  # 只探存在性

    win_name = {w[0]: (w[2] or w[1]) for w in windows}
    with open(os.path.join(out, '画面.tsv'), 'w', encoding='utf-8') as f:
        f.write('画面ID\t名称\t全名\t类型\t排序\n')
        for w in windows:
            f.write('\t'.join(str(x if x is not None else '') for x in w) + '\n')
    with open(os.path.join(out, '控件.tsv'), 'w', encoding='utf-8') as f:
        f.write('画面\t控件名\t类型\t控件ID\n')
        for comp in comps:
            f.write('\t'.join([win_name.get(comp[3], comp[3] or ''), comp[1] or '', comp[2] or '', comp[0] or '']) + '\n')
    tag_cols = [r[1] for r in c.execute('pragma table_info("VariableTagDetailsV2")')]
    with open(os.path.join(out, '变量.tsv'), 'w', encoding='utf-8') as f:
        f.write('变量名\t类型\t地址\t未解出说明\n')
        if not tag_cols:
            f.write('\t\t\t本工程无 VariableTagDetailsV2 表\n')
        else:
            n = c.execute('select count(*) from VariableTagDetailsV2').fetchone()[0]
            if not n:
                f.write('\t\t\t本工程变量表为空（控件地址在 Bin/fshmi.bin，见 控件地址.tsv）\n')

    # 控件地址：Bin/fshmi.bin 是编译后的屏程序，里面是「指令编号 + 地址」流
    # （SW n=开关/位、NE n=数值设定、AE n=字符串、OL n=…，后跟 D420/M45/Y4/SRW426 这类地址）
    import re
    fm = os.path.join(root, 'Bin', 'fshmi.bin')
    addr_rows = []
    if os.path.exists(fm):
        txt = open(fm, 'rb').read().decode('utf-8', errors='ignore')
        pending = None
        for t in re.findall(r'(?:SW|NE|AE|OL|SRB|SRW)\s?\d+|[A-Z]{1,3}\d+', txt):
            if re.match(r'^(SW|NE|AE|OL)\s?\d+$', t):
                pending = t
            elif pending and re.match(r'^[A-Z]{1,3}\d+$', t):
                addr_rows.append((pending, t))
                pending = None
    with open(os.path.join(out, '控件地址.tsv'), 'w', encoding='utf-8') as f:
        f.write('指令编号\t地址\t来源\n')
        for a, b2 in addr_rows:
            f.write(f'{a}\t{b2}\tfshmi.bin\n')

    print(f"OK {root}")
    print(f"  画面 {len(windows)} / 控件 {len(comps)} / 控件地址 {len(addr_rows)} → {out}")
    return 0

if __name__ == '__main__':
    sys.exit(main())
