#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hmismart-screen-xlsx.py —— 把 hmismart-db.mjs 的 12-文本.tsv 变成「画面｜文本」两列 Excel

为什么单独一步：数据库直读给出的是逐条文本（含英文、属性名、模板屏、成对的 开/关），
交付要的是「去重 + 按画面归并 + 成对合并 + 中文优先」的清单，这层规则放在脚本里，
下次工程更新重跑一遍就出同样的表。

用法：
    python hmismart-screen-xlsx.py <HMI解码目录> [输出.xlsx]

输入：<HMI解码目录>\12-文本.tsv 与 10-画面.tsv（同一目录，由 hmismart-db.mjs 产出）
输出：缺省写到 <HMI解码目录>\屏幕文本.xlsx

口径（屏上文本清单要的就是这些）：
  1. 只取「类型 = Screens」的文本对象（画面上的文字；属性、变量名、字体名不收）
  2. 只取含汉字的（纯英文、纯数字、英文+数字的不收）
  3. 首字符是 ASCII 字母/数字的不收
  4. Template 模板屏不收
  5. 同句空白差异归一（「故 障 复 位」与「故障复位」算一句，取空格最少的那种写法）
  6. 同一句在多屏出现只留一行，画面列用「、」合并
  7. 「XX开」与「XX关」成对合并成「XX开/关」
  8. 画面名去掉数字前缀，多屏按屏号排序
"""
import csv
import os
import re
import sys
from collections import Counter, defaultdict

TEXT_TSV = '12-文本.tsv'
SCREEN_TSV = '10-画面.tsv'


def strip_tag(s):
    s = (s or '').strip()
    m = re.match(r'^<text>(.*)</text>$', s, re.S)
    return m.group(1) if m else s


def has_cn(s):
    return bool(re.search(r'[\u4e00-\u9fff]', s or ''))


def nows(s):
    return re.sub(r'\s+', '', s)


def read_tsv(path):
    with open(path, encoding='utf-8') as f:
        return list(csv.DictReader(f, delimiter='\t'))


def screen_numbers(rows):
    """画面名 → 屏号。原型/模板屏（文件夹不是 HmiScreenFolder）不进映射。"""
    m = {}
    for r in rows:
        name = r.get('画面') or ''
        if not name or r.get('文件夹') != 'HmiScreenFolder':
            continue
        num = (r.get('屏号') or '').strip()
        if not num.lstrip('-').isdigit():
            continue
        n = int(num)
        if n < 0:
            continue
        if name not in m or n < m[name]:
            m[name] = n
    return m


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    deco = os.path.abspath(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(deco, '屏幕文本.xlsx')
    text_path = os.path.join(deco, TEXT_TSV)
    if not os.path.exists(text_path):
        print('缺少输入: ' + text_path)
        return 2

    text_rows = read_tsv(text_path)
    scr_rows = read_tsv(os.path.join(deco, SCREEN_TSV)) if os.path.exists(os.path.join(deco, SCREEN_TSV)) else []
    num_of = screen_numbers(scr_rows)

    pairs = []
    for r in text_rows:
        t = strip_tag(r.get('中文'))
        if not t or not has_cn(t):
            continue
        if (r.get('类型') or '').strip() != 'Screens':
            continue
        if (r.get('画面') or '') == 'Template':
            continue
        c = t[0]
        if c.isascii() and (c.isalpha() or c.isdigit()):
            continue
        raw = r.get('画面') or ''
        pairs.append((t, raw, re.sub(r'^\d+_', '', raw)))

    variants = defaultdict(Counter)
    screens_of = defaultdict(set)
    for t, raw, disp in pairs:
        k = nows(t)
        variants[k][t] += 1
        screens_of[k].add(raw)

    def pick(counter):
        return sorted(counter.items(), key=lambda kv: (kv[0].count(' '), len(kv[0]), -kv[1]))[0][0]

    text_of = {k: pick(v) for k, v in variants.items()}

    merged = {}
    for k in list(text_of):
        if k.endswith('开') and len(k) > 1 and (k[:-1] + '关') in text_of:
            base = k[:-1]
            merged[k] = base
            merged[base + '关'] = base
    merged['开'] = ''
    merged['关'] = ''

    final = defaultdict(set)          # 显示文本 -> 原始画面名集合
    for k, scrset in screens_of.items():
        if k in merged:
            base = merged[k]
            key = (base + '开/关') if base else '开/关'
        else:
            key = text_of[k]
        final[key] |= scrset

    def screen_key(raw):
        return (num_of.get(raw, 9000), re.sub(r'^\d+_', '', raw))

    items = sorted(final.items(), key=lambda kv: (min(screen_key(s)[0] for s in kv[1]), kv[0]))

    try:
        import openpyxl
        from openpyxl.styles import Alignment
    except Exception:
        print('缺 openpyxl：pip install openpyxl')
        return 3

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '屏幕文本'
    ws.append(['画面', '文本'])
    for text, scrset in items:
        names = sorted({re.sub(r'^\d+_', '', s) for s in scrset}, key=lambda n: (num_of.get(n, 9000), n))
        ws.append(['、'.join(names), text])
    ws.column_dimensions['A'].width = 34
    ws.column_dimensions['B'].width = 30
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row):
        for c in row:
            c.alignment = Alignment(wrap_text=True, vertical='center')
    ws.freeze_panes = 'A2'
    wb.save(out)

    print('rows=%d  merged_pairs=%d  out=%s' %
          (ws.max_row - 1, len([k for k in merged if k not in ('开', '关')]), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
