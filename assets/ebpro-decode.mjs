// ebpro-decode.mjs —— 威纶通 EasyBuilder Pro 工程解码（.emtp / 编译产物 .exob）
//
// 格式：.emtp 工程本体是「头 + 一大块压缩/加密数据」，读不出结构；同工程「编译」(F7)
// 生成的 .exob 是 UTF-8 明文，里面能读的有三段：
//   LABE_LIB          文字库：逐条 [1B 名长][1B 状态1长][1B 状态2长] + 三段 UTF-8（只有源语言）
//   画面对象记录       'HA' + 2 字节类型码 + 若干记录；记录 = 21 字节头（+0..+7 文字度量 u16，
//                     +12 语言槽 id，+14..+17 文本字节数 u32）+ UTF-8 文本 + 0x00
//   其余段（TAG_DATA / MACRO_ID …）内容未定，本解码器不解析、不猜。
//
// 用法：node ebpro-decode.mjs <工程.emtp | 编译产物.exob | 工程目录> [输出目录] [--exob 路径]
// 输出（默认 <cwd>/解码归档/<工程名>/HMI解码/）：
//   00-格式说明.md      来源、结构、判定口径、能解与不能解
//   10-画面.tsv         画面名(推定) / 编号(画面标题对象偏移) / 文字对象数
//   11-文字对象.tsv     所属画面(推定) / 类型码 / 语言槽 / 文字 / 度量 x y w h / 对象偏移
//   12-报警事件.tsv     对象偏移 / 语言槽 / 文本
//   13-文字库.tsv       条目名 / 状态1 / 状态2
//   HMI解码报告.md      概述 + 画面清单 + 语言槽分布 + 边界
//   08-统计.json        同一批数据的结构化版
// 只读：不修改工程与编译产物。
import fs from 'node:fs'
import path from 'node:path'

const TYPES = new Set([0x1410, 0x1408, 0x0402, 0x0401])
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const CJK = /[\u4e00-\u9fff]/
const LATIN = /[A-Za-z]{2,}/

const argv = process.argv.slice(2)
const flags = { exob: '' }
const pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--exob') flags.exob = argv[++i] || ''
  else pos.push(argv[i])
}
if (!pos[0]) {
  console.error('用法: node ebpro-decode.mjs <工程.emtp | 编译产物.exob | 工程目录> [输出目录] [--exob 路径]')
  process.exit(2)
}

function fail(msg) { console.error(msg); process.exit(3) }

/** 输入 → { exob, emtp }：.emtp/.目录 自动找同目录同名 .exob */
function resolveInputs(arg, exobArg) {
  const abs = path.resolve(arg)
  if (!fs.existsSync(abs)) fail(`路径不存在: ${arg}`)
  if (fs.statSync(abs).isDirectory()) {
    const files = fs.readdirSync(abs)
    const exobs = files.filter((f) => f.toLowerCase().endsWith('.exob'))
      .map((f) => path.join(abs, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    const emtps = files.filter((f) => f.toLowerCase().endsWith('.emtp'))
      .map((f) => path.join(abs, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    if (!exobs.length) fail(`目录里没有 .exob 编译产物：${abs}\n先在 EasyBuilder Pro 里编译（F7）再跑。`)
    return { exob: exobArg ? path.resolve(exobArg) : exobs[0], emtp: emtps[0] || '' }
  }
  const low = abs.toLowerCase()
  if (low.endsWith('.emtp')) {
    if (exobArg) return { exob: path.resolve(exobArg), emtp: abs }
    const sib = abs.replace(/\.emtp$/i, '.exob')
    if (!fs.existsSync(sib)) fail(`找不到同名编译产物：${sib}\n.emtp 本体压缩+加密，读不动；在 EasyBuilder Pro 里编译（F7）生成 .exob 后再跑。`)
    return { exob: sib, emtp: abs }
  }
  if (low.endsWith('.exob')) {
    const sib = abs.replace(/\.exob$/i, '.emtp')
    return { exob: abs, emtp: fs.existsSync(sib) ? sib : '' }
  }
  fail(`不认的输入：${arg}（要 .emtp 工程、.exob 编译产物或工程目录）`)
}

/** 工程本体头部：FF FE FF + 1 字节长 + UTF-16LE 的版本串（其余压缩+加密） */
function emtpMeta(p) {
  if (!p || !fs.existsSync(p)) return null
  const d = fs.readFileSync(p).subarray(0, 64)
  const i = d.indexOf(Buffer.from([0xff, 0xfe, 0xff]))
  const meta = { path: p, size: fs.statSync(p).size, mtime: fs.statSync(p).mtime }
  if (i >= 0 && i + 4 <= d.length) {
    const len = d[i + 3]
    meta.version = d.subarray(i + 4, i + 4 + len * 2).toString('utf16le')
  }
  return meta
}

/** LABE_LIB：条目名 + 状态1 + 状态2（只有源语言，没有译文） */
function parseLib(buf) {
  const at = buf.indexOf(Buffer.from('LABE_LIB'))
  if (at < 0) return []
  let p = at + 8 + 2
  const out = []
  while (p + 3 < buf.length) {
    const nl = buf[p], t1 = buf[p + 1], t2 = buf[p + 2]
    if (nl === 0 || nl > 100 || t1 > 200 || t2 > 200) break
    const q = p + 3
    if (q + nl + t1 + t2 > buf.length) break
    const name = buf.subarray(q, q + nl).toString('utf8')
    const s1 = buf.subarray(q + nl, q + nl + t1).toString('utf8')
    const s2 = buf.subarray(q + nl + t1, q + nl + t1 + t2).toString('utf8')
    out.push({ name, s1, s2 })
    p = q + nl + t1 + t2
  }
  return out
}

/** 记录流：21 字节头 + 文本 + 0x00 */
function parseRecords(buf, start, limit) {
  let p = start
  const out = []
  while (p + 21 <= limit) {
    const x = buf.readUInt16LE(p)
    const y = buf.readUInt16LE(p + 2)
    const w = buf.readUInt16LE(p + 4)
    const h = buf.readUInt16LE(p + 6)
    const lang = buf[p + 12]
    const len = buf.readUInt32LE(p + 14)
    const tsp = p + 21
    if (len === 0) { out.push({ x, y, w, h, lang, text: '', at: tsp }); p = tsp; continue }
    if (len > 400 || tsp + len >= limit) break
    const text = buf.subarray(tsp, tsp + len).toString('utf8')
    if (buf[tsp + len] !== 0) break
    out.push({ x, y, w, h, lang, text, at: tsp })
    p = tsp + len + 1
  }
  return { recs: out, next: p }
}

/** 对象：'HA' + 2 字节类型码 + 记录 */
function parseObjects(buf) {
  const out = []
  let p = 0
  while (true) {
    const j = buf.indexOf(Buffer.from('HA'), p)
    if (j < 0 || j + 4 > buf.length) break
    const ty = (buf[j + 2] << 8) | buf[j + 3]
    if (!TYPES.has(ty)) { p = j + 1; continue }
    const { recs, next } = parseRecords(buf, j + 5, Math.min(j + 6000, buf.length))
    if (recs.length) { out.push({ off: j, type: ty, recs }); p = next } else p = j + 1
  }
  return out
}

/** 能当文字用的记录：有字、无控制字符、语言槽 0..23（文件里夹着另一种 24 字节结构，会解出 NUL 串） */
const usable = (r) => {
  const t = r.text.trim()
  return t !== '' && !CTRL.test(t) && r.lang >= 0 && r.lang <= 23
}

const fmtTime = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function main() {
  const { exob, emtp } = resolveInputs(pos[0], flags.exob)
  const outDir = path.resolve(pos[1] || path.join(process.cwd(), '解码归档', path.basename(emtp || exob, path.extname(emtp || exob)), 'HMI解码'))
  fs.mkdirSync(outDir, { recursive: true })

  const buf = fs.readFileSync(exob)
  const lib = parseLib(buf)
  const objs = parseObjects(buf)
  if (!objs.length) fail(`没解析到画面对象：${exob}\n可能这份 .exob 不是 EasyBuilder Pro 编出来的。`)

  // 语言槽：源语言＝含中文最多的槽（并列取小），目标语言＝拉丁字母最多的槽
  const cjk = new Map(), latin = new Map()
  for (const o of objs) {
    for (const r of o.recs) {
      if (!usable(r)) continue
      if (CJK.test(r.text)) cjk.set(r.lang, (cjk.get(r.lang) || 0) + 1)
      else if (LATIN.test(r.text)) latin.set(r.lang, (latin.get(r.lang) || 0) + 1)
    }
  }
  const pick = (m, dflt) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? dflt
  const zhLang = pick(cjk, null)
  const enLang = pick(latin, null)

  // 画面：大号标签对象（0x1408 且度量 ≥ 150×35）
  const screens = objs.filter((o) => o.type === 0x1408
    && o.recs.some((r) => usable(r) && r.w >= 150 && r.h >= 35))
    .sort((a, b) => a.off - b.off)
    .map((o) => {
      let name = ''
      for (const r of o.recs) if (usable(r) && r.lang === zhLang) { name = r.text.trim(); break }
      if (!name) for (const r of o.recs) if (usable(r)) { name = r.text.trim(); break }
      return { off: o.off, name: name || '（无标题文字）' }
    })

  const screenOf = (off) => {
    let name = '（首屏之前）'
    for (const s of screens) if (off >= s.off) name = s.name
    return name
  }

  // 文字对象：同一对象内「同语言同文字」重复的只留一条
  const words = []
  for (const o of objs) {
    const seen = new Set()
    const recs = []
    for (const r of o.recs) {
      if (!usable(r)) continue
      const key = JSON.stringify([r.lang, r.text.trim()])
      if (seen.has(key)) continue
      seen.add(key)
      recs.push(r)
    }
    if (recs.length) words.push({ off: o.off, type: o.type, screen: screenOf(o.off), recs })
  }
  const events = words.filter((w) => w.type === 0x0401)
  const screenWords = words.filter((w) => w.type !== 0x0401)

  const langDist = {}
  for (const w of words) for (const r of w.recs) langDist[r.lang] = (langDist[r.lang] || 0) + 1

  const stat = {
    source: {
      exob: { path: exob, size: buf.length, mtime: fmtTime(fs.statSync(exob).mtime) },
      emtp: emtp ? { path: emtp, size: fs.statSync(emtp).size, mtime: fmtTime(fs.statSync(emtp).mtime), version: emtpMeta(emtp)?.version } : null,
    },
    languages: { source: zhLang, target: enLang, distribution: langDist },
    counts: { screens: screens.length, screenTextObjects: screenWords.length, events: events.length, library: lib.length },
    screens,
    objects: words,
    library: lib,
  }

  const w = (name, content) => fs.writeFileSync(path.join(outDir, name), content, 'utf8')
  const tsv = (head, rows) => head + '\n' + rows.map((r) => r.join('\t')).join('\n') + '\n'

  w('10-画面.tsv', tsv('画面名(推定)\t编号(标题对象偏移)\t文字对象数',
    screens.map((s) => [s.name, '0x' + s.off.toString(16).toUpperCase(), screenWords.filter((x) => x.screen === s.name).length])))

  w('11-文字对象.tsv', tsv('所属画面(推定)\t类型码\t语言槽\t文字\t度量x\t度量y\t宽\t高\t对象偏移',
    screenWords.flatMap((x) => x.recs.map((r) => [x.screen, '0x' + x.type.toString(16).toUpperCase().padStart(4, '0'),
      r.lang, r.text.trim().replace(/\t/g, ' '), r.x, r.y, r.w, r.h, '0x' + x.off.toString(16).toUpperCase()]))))

  w('12-报警事件.tsv', tsv('对象偏移\t语言槽\t文本',
    events.flatMap((x) => x.recs.map((r) => ['0x' + x.off.toString(16).toUpperCase(), r.lang, r.text.trim().replace(/\t/g, ' ')]))))

  w('13-文字库.tsv', tsv('条目名\t状态1\t状态2',
    lib.map((e) => [e.name, e.s1.trim(), e.s2.trim()])))

  const stale = emtp && fs.statSync(emtp).mtimeMs > fs.statSync(exob).mtimeMs + 60000

  w('00-格式说明.md', [
    '# 威纶通 EasyBuilder Pro（.emtp / .exob）格式说明',
    '',
    '| 文件 | 是什么 | 能不能读 |',
    '|---|---|---|',
    '| `.emtp` | 工程本体 | 头 4 字节后有 `FF FE FF + 1 字节长 + UTF-16LE` 的工程版本串；其后是压缩+加密数据，读不出结构 |',
    '| `.exob` | 编译产物（软件里编译一次，与工程同名同目录） | UTF-8 明文：文字库段 `LABE_LIB` + 画面对象记录 + 若干未定段 |',
    '',
    '## 结构（本解码器用到的那两段）',
    '',
    '- `LABE_LIB`：标记后跳 2 字节，逐条 `[1B 名长][1B 状态1长][1B 状态2长]` + 三段 UTF-8。这一段**只有源语言**，没有译文。',
    '- 对象记录：`HA` + 2 字节类型码 + 若干记录；记录 = 21 字节头（`+0..+7` 文字度量 u16 x/y/w/h，`+12` 语言槽 id，`+14..+17` 文本字节数 u32）+ UTF-8 文本 + `0x00`。',
    '- 类型码原值：`0x1408` / `0x1410` / `0x0402` / `0x0401`；含义未判死，表里只用码不写类别名。',
    '',
    '## 判定口径',
    '',
    '- 语言槽：源语言＝含中文最多的槽（并列取小）；目标语言＝拉丁字母最多的槽。',
    '- 画面：以「度量 ≥ 150×35 的 0x1408 标签对象」当画面标题，其后的对象归这个画面；没有标题对象的画面会并到上一个。',
    '- 噪声过滤：文本含控制字符、或语言槽 id 不在 0..23 的记录不是文字（文件里夹着另一种 24 字节结构，按本格式会解出 NUL 串）。',
    '',
    '## 能解与不能解',
    '',
    '- 能解：画面名（推定）、文字对象（所属画面/类型码/语言槽/文字/度量/偏移）、报警事件文本、文字库条目、工程版本。',
    '- 不能解：工程本体 `.emtp`（压缩+加密）；控件几何与画面坐标；PLC 地址与变量绑定（编译产物里没有可读的标签表段）。',
    '- 度量列 x/y/w/h 是字串外框度量，不是画面坐标。',
    '',
  ].join('\n'))

  const L = []
  L.push(`# ${path.basename(emtp || exob, path.extname(emtp || exob))} · EasyBuilder Pro HMI 解码报告`)
  L.push('')
  L.push(`- 编译产物: ${path.basename(exob)}（${fmtTime(fs.statSync(exob).mtime)}，${(buf.length / 1048576).toFixed(2)} MB，UTF-8 明文段）`)
  L.push(emtp ? `- 工程文件: ${path.basename(emtp)}（${(fs.statSync(emtp).size / 1048576).toFixed(2)} MB，工程版本 ${emtpMeta(emtp)?.version || '未知'}；本体压缩+加密）` : '- 工程文件: （未提供，只给了编译产物）')
  L.push(`- 规模: 画面 ${screens.length}（推定）/ 文字对象 ${screenWords.length} / 报警事件 ${events.length} / 文字库 ${lib.length} 条`)
  L.push(`- 语言槽: 源 ${zhLang ?? '未识别'} / 目标 ${enLang ?? '未识别'}；分布 ${Object.entries(langDist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} 槽 ${v} 条`).join('，')}`)
  if (stale) L.push(`- 注意: 工程比编译产物新，表是上一次编译的状态；要最新就在软件里重新编译再跑`)
  L.push('')
  L.push('## 画面清单')
  L.push('')
  L.push('| 画面名(推定) | 文字对象数 | 标题对象偏移 |')
  L.push('|---|---|---|')
  for (const s of screens) L.push(`| ${s.name.replace(/\|/g, '/')} | ${screenWords.filter((x) => x.screen === s.name).length} | 0x${s.off.toString(16).toUpperCase()} |`)
  L.push('')
  L.push('## 报警事件（前 40）')
  L.push('')
  L.push('| 语言槽 | 文本 |')
  L.push('|---|---|')
  for (const x of events.slice(0, 40)) for (const r of x.recs) L.push(`| ${r.lang} | ${r.text.trim().replace(/\|/g, '/')} |`)
  L.push('')
  L.push('## 文字库（前 40）')
  L.push('')
  L.push('| 条目名 | 状态1 | 状态2 |')
  L.push('|---|---|---|')
  for (const e of lib.slice(0, 40)) L.push(`| ${e.name.replace(/\|/g, '/')} | ${e.s1.trim().replace(/\|/g, '/')} | ${e.s2.trim().replace(/\|/g, '/')} |`)
  L.push('')
  L.push('先读这份；原始表在 10-画面.tsv / 11-文字对象.tsv / 12-报警事件.tsv / 13-文字库.tsv，结构化数据在 08-统计.json。')
  w('HMI解码报告.md', L.join('\n') + '\n')
  w('08-统计.json', JSON.stringify(stat, null, 1))

  console.log(`OK ${path.basename(emtp || exob)} → ${outDir}`)
  console.log(`   画面 ${screens.length}（推定）/ 文字对象 ${screenWords.length} / 报警事件 ${events.length} / 文字库 ${lib.length} 条`)
  console.log(`   语言槽: 源 ${zhLang ?? '?'} / 目标 ${enLang ?? '?'}`)
  if (stale) console.log('   注意: 工程比编译产物新，表是上一次编译的状态')
}

main()
