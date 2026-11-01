// decode-pack.mjs —— 解码产物落盘形态（合并版）
//
// 一份数据一处落，按读者分三路：
//   · 目录件：00-目录.md（块表＋怎么查＋文件清单）——AI 只先读这一份
//   · AI 件：程序.lad（网络级逻辑）、元素记录.tsv（块内序号＋指令＋操作数）、
//            符号地址.tsv（用户变量/系统符号/子程序参数合并一张表）、分析.md（算出来的部分）
//   · 人看件：梯形图在对话里按需出，本目录不存图
//   · 机器件：记录.json、字符串全录.txt（兄弟工具按这两个名字认已解码目录）
//
// 合并：块级操作数流.tsv 与元素记录.tsv 信息重叠（后者有序号即可）；
// 符号.tsv 与子程序接口.tsv 都是「名字↔地址」，并成 符号地址.tsv；解码报告.md 降为指路页。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const B = (s) => Buffer.byteLength(s, 'utf8')
const off4 = (o) => String(o || '').replace(/^0x/, '').toUpperCase()
const num = (n) => Number(n || 0).toLocaleString('en-US')

/** LAD 指令序列压成 AI 件：[盒] 那行长注释换成 [盒N]，去掉尾部空白 */
export function compactLad(raw) {
  let t = raw
    .replace(/^# 说明：[\s\S]*?\n# 指令盒[^\n]*\n/m, '')
    .replace(/^## 块：/gm, '## ')
    .replace(/\[盒\]\s+← 位次 (\d+)（指令盒记录，未列元件行）/g, '[盒$1]')
    .replace(/[ \t]+$/gm, '')
  return '# LAD 指令序列：LD/A/O/AN/ON 触点、EU/ED 边沿、LPS/LRD/LPP 并联支路、=/S/R 线圈、比较带第二操作数\n'
    + '# [盒N] = 该位次是指令盒，盒内实参见 元素记录.tsv 同一块的行\n\n' + t.trimStart()
}

/** 从原报告里切出「算出来的」分析节（记录类的 2 与 2.5 不要——那是记录的第二遍） */
export function sliceAnalysis(reportText) {
  const secs = {}
  let cur = '', buf = []
  for (const ln of reportText.split('\n')) {
    const m = /^## (\S.*)$/.exec(ln)
    if (m) { if (cur) secs[cur] = buf.join('\n'); cur = m[1]; buf = [] } else buf.push(ln)
  }
  if (cur) secs[cur] = buf.join('\n')
  let out = ''
  for (const [k, v] of Object.entries(secs)) {
    if (/^(2\.[6-9]|2\.7b|3\.5|3\.6|3\.7|5\.)/.test(k)) out += `## ${k}\n${v}\n`
  }
  return out
}

/** CoDeSys/DVP 侧的导航件：人看 ST 源码（pous/）或指令表报告，AI 先读本页与源码 */
export function writeSourcePack({ outd, kind, projName, projFile }) {
  const list = []
  const pousDir = path.join(outd, 'pous')
  if (fs.existsSync(pousDir)) {
    for (const f of fs.readdirSync(pousDir)) {
      const p = path.join(pousDir, f)
      if (!fs.statSync(p).isFile()) continue
      const t = fs.readFileSync(p, 'utf8')
      list.push({ name: f.replace(/\.txt$/, ''), file: `pous/${f}`, bytes: B(t), lines: t.split('\n').length })
    }
    list.sort((a, b) => b.bytes - a.bytes)
  }
  const sizeOf = (p) => { try { return B(fs.readFileSync(path.join(outd, p), 'utf8')) } catch { return 0 } }
  const has = (p) => fs.existsSync(path.join(outd, p))
  let nav = `# ${projName || path.basename(projFile || outd)} · 解码索引（${kind}）\n\n`
  nav += `- 源文件: ${path.basename(projFile || '')}\n- 输出目录: ${outd}\n`
  nav += `- 规模: ${list.length ? `POU/对象 ${list.length} 个` : '（见下方文件清单）'}\n\n## 文件\n\n| 文件 | 大小 | 读者 | 说明 |\n|---|---|---|---|\n`
  if (list.length) nav += `| pous/ | ${num(list.reduce((n, x) => n + x.bytes, 0))} B（${list.length} 个） | 人＋AI | **看程序用这个**：每个 POU 一份 ST 源码（含注释与变量声明），按需要的那份读 |\n`
  if (has('工程内容报告.md')) nav += `| 工程内容报告.md | ${num(sizeOf('工程内容报告.md'))} B | 证据 | 对象树逐对象的原始串（含 GUID/属性），人不必通读 |\n`
  if (has('解码报告.md')) nav += `| 解码报告.md | ${num(sizeOf('解码报告.md'))} B | AI | 结构/段落注释/设备注释/指令表反汇编 |\n`
  if (has('程序解读.md')) nav += `| 程序解读.md | ${num(sizeOf('程序解读.md'))} B | 人 | 网络级功能地图＋I/O 表＋机制链＋未确证清单（人工解读，重解码不覆盖） |\n`
  if (has('全部字符串.txt')) nav += `| 全部字符串.txt | ${num(sizeOf('全部字符串.txt'))} B | 检索 | 全工程可读串（按出现顺序编号），查关键词用 |\n`
  if (has('对象表.md')) nav += `| 对象表.md | ${num(sizeOf('对象表.md'))} B | AI | 对象清单 |\n`
  if (has('项目树.md')) nav += `| 项目树.md | ${num(sizeOf('项目树.md'))} B | AI | 项目树 |\n`
  if (kind === 'dvp') {
    nav += `\n## 怎么查（按问题挑一条，别整份读）\n\n`
    nav += `- 某段指令表 → 按下文「网络行号表」取段（行号＝解码报告里的行，从 1 起）\n`
    nav += `- 某地址在哪些网络出现 → grep 地址（如 \`grep -n "D2340" 解码报告.md\`），只读命中的那几行\n`
    nav += `- 找中文注释/设备名/画面文本 → grep 全部字符串.txt\n\n`
    nav += `## 读法\n\n- **看程序**：台达 DVP 没有 pous/ST，程序就是 \`解码报告.md\` 的指令表（按 \`LD M1000\` 分网络，末尾 END）。\n- **AI**：目录里有 \`程序解读.md\` 就先读它（网络级功能地图＋I/O 表＋机制链＋未确证清单），再回指令表逐段核对。报告里 \`?名\`（如 \`?DRVI\`）与 \`?CMP(关系)\` 是**推断**指令名——报告末尾有「推断对照表」（码／推测名／依据／把握），拿它下结论前先核台达指令表；\`??xx\` 与 \`?CMP[六位]\` 是推断不出、保持未定的。\n- 读之前核对源工程文件修改时间是否与本次解码一致（工程一改，导出即过期）。\n`

    // 网络行号表：让 AI 能按行号取一段，而不是整份读报告
    const rep = path.join(outd, '解码报告.md')
    if (fs.existsSync(rep)) {
      const lines = fs.readFileSync(rep, 'utf8').split('\n')
      const starts = []
      for (let i = 0; i < lines.length; i++) {
        if (/\bLD\s+M1000\b/.test(lines[i]) && /^\s*(行\s*\d+\s*[:：])?\s*LD\s+M1000\b/.test(lines[i])) starts.push(i + 1)
      }
      if (starts.length) {
        const CAP = 50
        nav += `\n## 网络定位（共 ${starts.length} 个网络；要哪段用 按行号取段，别整份读）\n\n| # | 起始行 | 首条 |\n|---|---|---|\n`
        for (let k = 0; k < Math.min(starts.length, CAP); k++) {
          const from = starts[k]
          const head = (lines[from - 1] || '').trim().replace(/^行\s*\d+\s*[:：]\s*/, '').slice(0, 46).replace(/\|/g, '\\|')
          nav += `| ${k + 1} | ${from} | ${head} |\n`
        }
        if (starts.length > CAP) nav += `\n（其余 ${starts.length - CAP} 个网络按行号顺延，或直接 grep 地址定位）\n`
      }
    }
  } else {
    nav += `\n## 读法\n\n- **看程序**：读 pous/<名字>.txt（ST 本体，结构化、最小）。\n- **AI**：先读本页 → 按 POU 读源码（grep 变量名/地址即可跨 POU 定位）；要全量检索用 全部字符串.txt。\n- 读源码前先核对源工程文件的修改时间是否与本次解码一致（工程一改，导出即过期）。\n`
  }
  if (list.length) {
    nav += `\n## POU/对象清单\n\n| # | 名称 | 大小 | 行 | 文件 |\n|---|---|---|---|---|\n`
    list.forEach((x, i) => { nav += `| ${i + 1} | ${x.name} | ${num(x.bytes)} | ${x.lines} | ${x.file} |\n` })
  }
  fs.writeFileSync(path.join(outd, '00-索引.md'), nav, 'utf8')
  return { nav: B(nav), pous: list.length }
}

export function writeSmartPack({ out, projName, fingerprint, container, version, records, userSyms, sysSyms, blockStreams, blockIfaces, blockStats, reportText, smartPath }) {
  const blocks = []
  const byBlock = new Map()
  for (const r of records) { if (!byBlock.has(r.pou)) { byBlock.set(r.pou, []); blocks.push(r.pou) } byBlock.get(r.pou).push(r) }

  // ── AI 件：元素记录（块内序号；偏移不再进表——AI 按块+序号就能定位，偏移留给 记录.json）──
  const recLines = ['块\t序号\t指令\t操作数']
  const ranges = []
  let ln = 1
  for (const b of blocks) {
    const st = ln + 1
    let k = 0
    for (const r of byBlock.get(b)) { recLines.push(`${b}\t${++k}\t${r.instr}\t${(r.operands || []).join(';')}`); ln++ }
    ranges.push({ block: b, from: st, to: ln, n: byBlock.get(b).length })
  }
  const recTxt = recLines.join('\n') + '\n'
  fs.writeFileSync(path.join(out, '元素记录.tsv'), recTxt, 'utf8')

  // ── AI 件：符号地址（用户变量＋系统符号＋子程序参数，合并一张表）──
  const symLines = ['种类\t名字\t地址\t类型']
  for (const s of (userSyms || [])) symLines.push(`用户变量\t${s.name}\t${s.addr}\t`)
  for (const s of (sysSyms || [])) symLines.push(`系统符号\t${s.name}\t${s.addr}\t`)
  let ifaceCount = 0
  for (const b of (blockIfaces || [])) {
    for (const i of (b.ifs || [])) { symLines.push(`子程序参数\t${b.name}.${i.name}\t${i.addr || ''}\t${i.type || ''}`); ifaceCount++ }
  }
  const symTxt = symLines.join('\n') + '\n'
  fs.writeFileSync(path.join(out, '符号地址.tsv'), symTxt, 'utf8')

  // ── AI 件：分析（算出来的部分）──
  const anaTxt = sliceAnalysis(reportText)
  fs.writeFileSync(path.join(out, '分析.md'), anaTxt, 'utf8')

  // ── AI 件：程序.lad（网络级逻辑）──
  let ladTxt = ''
  try {
    ladTxt = compactLad(execFileSync(process.execPath, [path.join(HERE, 'smart-lad.mjs'), smartPath], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 180000 }))
  } catch (e) { ladTxt = '' }
  if (ladTxt) fs.writeFileSync(path.join(out, '程序.lad'), ladTxt, 'utf8')

  // ── 网络数：从 程序.lad 数 ──
  const netOf = {}
  if (ladTxt) {
    let cur = null
    for (const ln of ladTxt.split('\n')) {
      const m = /^## (.+)$/.exec(ln)
      if (m) { cur = m[1].trim(); netOf[cur] = 0; continue }
      if (cur && /^Network \d+/.test(ln)) netOf[cur]++
    }
  }
  const statOf = new Map((blockStats || []).map((s) => [s.name, s]))
  const sizeOf = (p) => { try { return B(fs.readFileSync(path.join(out, p), 'utf8')) } catch { return 0 } }

  // ── 目录件（AI 先读这一份；目标 2K 以内）──
  let dir = `# ${projName || '(未命名)'} · 目录\n\n`
  dir += `- 源文件: ${fingerprint.file} ${num(fingerprint.size)} B ${fingerprint.mtime}（用前核指纹，不一致＝已过期）\n`
  dir += `- 规模: 块 ${blocks.length} / 元素 ${records.length} / 用户变量 ${(userSyms || []).length} / 系统符号 ${(sysSyms || []).length} / 子程序参数 ${ifaceCount}\n`
  if (version) dir += `- 文档版本: ${version}${container ? `；容器: ${container}` : ''}\n`
  dir += `\n## 块\n\n| 块 | 网络 | 元素 | 子程序参数 | 被调用 |\n|---|---|---|---|---|\n`
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const st = statOf.get(b) || {}
    const ifs = ((blockIfaces || []).find((x) => x.name === b)?.ifs || []).length
    const nets = netOf[b] ?? '—'
    dir += `| ${b} | ${nets} | ${ranges[i].n} | ${ifs} | ${st.calls ?? '—'} |\n`
  }
  dir += `\n## 怎么查（按问题挑一条，别整份读文件）\n\n`
  dir += `- 某地址谁写谁读 → \`smart-ladder-elements\` addr=VD20（一批用逗号）\n`
  dir += `- 某块某网络的梯形图 → \`smart-lad\` block=自动 net=3\n`
  dir += `- 子程序内部结构（参数/盒链/调用点）→ \`smart-pou-structure\` pou=<块名>\n`
  dir += `- 地址规划与空闲段 → \`smart-free-space\`；地址冲突体检 → \`smart-conflict\`\n`
  dir += `- 字节级核对（排查用，出偏移）→ \`smart-net-trace\` / \`smart-box-pins\`\n`
  dir += `\n## 文件（要什么读什么）\n\n| 文件 | 大小 | 用途 | 读不读 |\n|---|---|---|---|\n`
  if (ladTxt) dir += `| 程序.lad | ${num(sizeOf('程序.lad'))} B | 按块分段的网络级逻辑 | 要逻辑时读，按 ## 块名定位 |\n`
  dir += `| 元素记录.tsv | ${num(B(recTxt))} B | 块\\t序号\\t指令\\t操作数 | 按块 grep，不要整份读 |\n`
  dir += `| 符号地址.tsv | ${num(B(symTxt))} B | 名字↔地址（含子程序参数） | grep 名字 |\n`
  dir += `| 分析.md | ${num(B(anaTxt))} B | 信号流/空闲段/静态体检等算出来的结论 | 要结论时读 |\n`
  dir += `| 记录.json | ${num(sizeOf('记录.json'))} B | 兄弟工具的输入（含偏移与全量记录） | AI 不读 |\n`
  dir += `| 字符串全录.txt | ${num(sizeOf('字符串全录.txt'))} B | 工程内全部可读串 | 查关键词时才 grep |\n`
  dir += `\n梯形图不落盘：按需用 smart-lad 取某块某网络的指令序列（串并联/边沿/比较）。\n`
  fs.writeFileSync(path.join(out, '00-目录.md'), dir, 'utf8')

  // ── 指路页：保留 解码报告.md 这个名字（兄弟工具按它认目录），内容只留指路 ──
  let nav = `# ${projName || '(未命名)'} · 解码产物\n\n`
  nav += `- 源文件指纹: ${fingerprint.file} ${num(fingerprint.size)} B / ${fingerprint.mtime}（用前先核对；不一致＝已过期）\n`
  nav += `- **先读 00-目录.md**（块表＋怎么查＋文件清单）；本页只是指路，已不再写全量报告。\n`
  nav += `- 文件：程序.lad（逻辑）／元素记录.tsv（盒实参）／符号地址.tsv（名字↔地址）／分析.md（结论）／记录.json（机器件）／字符串全录.txt（检索）\n`
  nav += `- 梯形图不落盘，在对话里出。\n`
  fs.writeFileSync(path.join(out, '解码报告.md'), nav, 'utf8')

  const sizes = {
    '00-目录.md': B(dir), '程序.lad': B(ladTxt), '元素记录.tsv': B(recTxt), '符号地址.tsv': B(symTxt), '分析.md': B(anaTxt),
  }
  const total = B(dir) + B(ladTxt) + B(recTxt) + B(symTxt) + B(anaTxt)
  return { sizes, total }
}
