#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""加密 .project 的降级解码通道。

背景：CoDeSys/LeadSysStudio 可以把工程保存成加密 .project（不是 zip，整文件高熵）。
这种工程读不出 ST 源码与梯形图，但同一目录里通常留着编译缓存
（`<工程名>.precompilecache`，实际是 zip，内含一个序列化的 cache 文件），
缓存里有全部标识符与中文变量名/注释。

本脚本只从缓存里抽两类可核验的东西，不做任何猜测：
  ① ASCII 标识符（长度 >= 4，出现即记录）
  ② GBK 中文串（连续双字节，能严格解成中文，长度 >= 3 字）

输出：<outdir>/00-目录.md、符号名.txt、中文名与注释.txt
用法：python precompile_extract.py <工程目录或 .project 路径> <输出目录>
"""
import os
import re
import sys
import zipfile


def find_cache(proj_path):
    """定位同目录下的 *.precompilecache（可能多个，取最大的）。"""
    d = proj_path if os.path.isdir(proj_path) else os.path.dirname(proj_path)
    cands = []
    try:
        for n in os.listdir(d):
            if n.lower().endswith('.precompilecache'):
                p = os.path.join(d, n)
                cands.append((os.path.getsize(p), p))
    except OSError:
        return None
    if not cands:
        return None
    cands.sort(reverse=True)
    return cands[0][1]


def read_cache_bytes(cache_path):
    """precompilecache 是 zip（内含一个同名条目）；也兼容裸缓存文件。"""
    try:
        with zipfile.ZipFile(cache_path) as z:
            names = z.namelist()
            if names:
                return z.read(names[0]), names[0]
    except Exception:
        pass
    with open(cache_path, 'rb') as f:
        return f.read(), os.path.basename(cache_path)


ASCII_RE = re.compile(rb'[\x20-\x7e]{4,}')
CN_RE = re.compile(r'[\u4e00-\u9fa5]{2,}')


def extract(data):
    names = []
    for m in ASCII_RE.finditer(data):
        s = m.group().decode('ascii', 'ignore').strip()
        if s:
            names.append(s)
    cns = []
    i, n = 0, len(data) - 1
    while i < n:
        b0, b1 = data[i], data[i + 1]
        if 0x81 <= b0 <= 0xFE and 0x40 <= b1 <= 0xFE and b1 != 0x7F:
            j = i
            while j < n and 0x81 <= data[j] <= 0xFE and 0x40 <= data[j + 1] <= 0xFE and data[j + 1] != 0x7F:
                j += 2
            if j - i >= 6:
                try:
                    t = data[i:j].decode('gbk')
                except Exception:
                    t = ''
                if t and CN_RE.search(t):
                    cns.append(t)
            i = j
        else:
            i += 1
    return names, cns


KEYWORD = re.compile(
    r'^(IF|THEN|ELSE|ELSIF|END_IF|CASE|OF|FOR|TO|BY|DO|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|'
    r'VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|END_VAR|PROGRAM|FUNCTION|FUNCTION_BLOCK|END_PROGRAM|'
    r'END_FUNCTION|END_FUNCTION_BLOCK|TRUE|FALSE|AND|OR|NOT|XOR|MOD|AT|RETAIN|CONSTANT)$')


def main():
    if len(sys.argv) < 3:
        print('用法: precompile_extract.py <工程目录或 .project> <输出目录>')
        return 2
    proj, outd = sys.argv[1], sys.argv[2]
    cache = find_cache(proj)
    if not cache:
        print('FAIL 未找到 .precompilecache：该工程既不是 zip，也没有可用的编译缓存')
        return 1
    data, inner = read_cache_bytes(cache)
    names, cns = extract(data)
    # 去重并保留出现顺序；纯数字/纯符号的噪声去掉
    seen, uniq_names = set(), []
    for s in names:
        if len(s) < 4 or s in seen:
            continue
        if not re.search(r'[A-Za-z_]', s):
            continue
        seen.add(s)
        uniq_names.append(s)
    seen_cn, uniq_cn = set(), []
    for s in cns:
        if s in seen_cn:
            continue
        seen_cn.add(s)
        uniq_cn.append(s)

    os.makedirs(outd, exist_ok=True)
    with open(os.path.join(outd, '符号名.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(uniq_names) + '\n')
    with open(os.path.join(outd, '中文名与注释.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(uniq_cn) + '\n')

    proj_name = os.path.basename(proj)
    size_mb = round(len(data) / 1048576, 1)
    md = []
    md.append('# %s · 降级解码（加密工程）\n' % proj_name)
    md.append('## 这是什么\n')
    md.append('- 源工程 `.project` 不是 zip（整文件高熵），是 CoDeSys/LeadSysStudio 的**加密保存**：源码与梯形图读不出来。\n')
    md.append('- 本目录的内容来自同目录编译缓存 `%s`（解压后 %s MB，条目 `%s`），只抽可核验的名字，不做猜测。\n' % (os.path.basename(cache), size_mb, inner))
    md.append('- **能回答**：这台机器有哪些变量/功能块/中文名与注释（约 %d 个标识符、%d 条中文串）。\n' % (len(uniq_names), len(uniq_cn)))
    md.append('- **不能回答**：某段逻辑怎么接（串并联/边沿）、某地址谁写谁读、梯形图——这些只在加密的源码里。要这些，只能让原作者在软件里「另存为非加密工程」或导出 ST/源程序。\n')
    md.append('\n## 文件\n\n| 文件 | 内容 |\n|---|---|\n')
    md.append('| 符号名.txt | 全部 ASCII 标识符（变量名/块名/指令名/库常量，按出现顺序去重） |\n')
    md.append('| 中文名与注释.txt | 全部 GBK 中文串（变量中文名、注释、报警文本） |\n')
    md.append('\n## 怎么用\n')
    md.append('- 问「这台机器有哪些功能点/报警/参数」→ 读 中文名与注释.txt（按关键词 grep）。\n')
    md.append('- 问「某个变量叫什么、属于哪个块」→ 在 符号名.txt 里 grep 前缀（如 `ACS_`、`ADDAXIS_`）。\n')
    md.append('- 不要拿这两个文件推逻辑：它们只有名字，没有程序结构。\n')
    with open(os.path.join(outd, '00-目录.md'), 'w', encoding='utf-8') as f:
        f.write(''.join(md))
    print('OK 降级解码完成: %s -> %s（标识符 %d、中文串 %d）' % (os.path.basename(cache), outd, len(uniq_names), len(uniq_cn)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
