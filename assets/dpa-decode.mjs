/**
 * dpa-decode.mjs —— 台达 DIAScreen 触摸屏工程（.dpa）全量解码器
 *
 * 容器：.dpa = BMP 缩略图（24bpp）+ gzip
 * 正文：gzip 解开后 41 字节文件头 + 异或 0x64 的 INI 文本
 *   - 节 = [名] + key=value 行；*Len* 类键后跟 N 字节内嵌块（UTF-16 文本 / GBK 串 / 宏）
 *   - [Picture]：Size=N 后是图片库，每条 44 字节头 + w*h*4 BGRA
 *   - 数字前缀节（如 [100_SRAM_DATA]）：二进制载荷，工程里常是一整个 SQLite 库
 *   - 元件记录尾部还跟一小段二进制（未定语义），原样导出
 *
 * 用法: node dpa-decode.mjs <工程.dpa> <输出目录>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { gunzipSync, deflateSync } from 'node:zlib'

const [, , dpaPath, outDirArg] = process.argv
if (!dpaPath || !outDirArg) { console.error('用法: node dpa-decode.mjs <工程.dpa> <输出目录>'); process.exit(2) }
const outDir = outDirArg
mkdirSync(join(outDir, '20-图片'), { recursive: true })
mkdirSync(join(outDir, '91-二进制块'), { recursive: true })

// ═════════ 1. 拆容器 ═════════
const raw = readFileSync(dpaPath)
if (raw.length < 64 || raw[0] !== 0x42 || raw[1] !== 0x4d) throw new Error('不是 .dpa：缺 BMP 缩略图头')
const thumbEnd = raw.readUInt32LE(10) + raw.readUInt32LE(34)
let gz = -1
for (let i = Math.min(thumbEnd, raw.length - 2); i < raw.length - 1; i++) if (raw[i] === 0x1f && raw[i + 1] === 0x8b) { gz = i; break }
if (gz < 0) for (let i = 0; i < raw.length - 1; i++) if (raw[i] === 0x1f && raw[i + 1] === 0x8b) { gz = i; break }
if (gz < 0) throw new Error('不是 .dpa：找不到 gzip 体')
const payload = gunzipSync(raw.subarray(gz))

const APP = Buffer.from([0x3f, 0x25, 0x14, 0x14, 0x08, 0x0d, 0x07, 0x05, 0x10, 0x0d, 0x0b, 0x0a]) // 异或后的 "[Application]"
const bodyStart = payload.indexOf(APP)
if (bodyStart < 0) throw new Error('不是 DIAScreen 工程：异或后找不到 [Application]')
const fileHeader = (payload.subarray(0, bodyStart).toString('latin1').match(/^[\x20-\x7e]+/) ?? [''])[0].trim()
const body = Buffer.alloc(payload.length - bodyStart)
for (let i = bodyStart; i < payload.length; i++) body[i - bodyStart] = payload[i] ^ 0x64
const bodyStr = body.toString('latin1')

// ═════════ 2. 文本解码 ═════════
const gbk = new TextDecoder('gbk')
function decodeBytes(buf) {
  if (!buf || buf.length === 0) return ''
  if (buf.every(b => b === 0x0a || b === 0x0d || b === 0x09 || (b >= 0x20 && b < 0x7f))) return buf.toString('latin1')
  if (buf.length % 2 === 0) {
    let bad = 0
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const c = buf[i] | (buf[i + 1] << 8)
      if (!(c === 0 || c === 0x0d || c === 0x0a || (c >= 0x20 && c < 0xd800) || (c >= 0xe000 && c <= 0xfffd))) bad++
    }
    if (bad === 0) {
      const s = buf.toString('utf16le').replace(/\u0000+$/g, '')
      if (/^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(s)) return s
    }
  }
  try { const s = gbk.decode(buf); if (s && !/\ufffd/.test(s)) return s } catch { /* 二进制 */ }
  return null
}
const cls = v => decodeBytes(Buffer.from(v, 'latin1')) ?? v
const q = v => String(v ?? '').replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ').trim()

// ═════════ 3. 按节切分 ═════════
const SEC_RE = /(?:^|\r\n)\[([A-Za-z0-9_ .]{1,48})\]/g
const marks = []
for (const m of bodyStr.matchAll(SEC_RE)) marks.push({ name: m[1].trim(), at: m.index + (m[0].startsWith('\r\n') ? 2 : 0) })
const sections = marks.map((mk, i) => {
  const close = bodyStr.indexOf(']', mk.at)
  let cs = close + 1
  const end = i + 1 < marks.length ? marks[i + 1].at : body.length
  while (cs < end && (body[cs] === 0x0d || body[cs] === 0x0a)) cs++
  return { name: mk.name, start: mk.at, contentStart: cs, end, index: i }
})
const headBytes = sections.length ? sections[0].start : body.length

const records = []
const binarySections = []
const tailBlobs = []
const pictures = []
let pictureBytes = 0
const pictureCover = []

function parseIni(sec) {
  const kv = []
  const blobs = {}
  let p = sec.contentStart
  while (p < sec.end) {
    let e = p
    while (e < sec.end && body[e] !== 0x0d && body[e] !== 0x0a) e++
    const line = bodyStr.slice(p, e)
    const eq = line.indexOf('=')
    if (eq <= 0) {
      const tail = body.subarray(p, sec.end)
      if (tail.length) blobs.$tail = tail
      break
    }
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1)
    kv.push([key, val])
    let nx = e
    while (nx < sec.end && (body[nx] === 0x0d || body[nx] === 0x0a)) nx++
    // 只有「文本/宏/内存」这类字段后面才跟内嵌块；
    // AccountLen/PasswordLen/DirectoryLen 这类是字段宽度，后面没有数据——按白名单收窄，否则会把下一行当数据吞掉。
    const isLen = /^w[A-Za-z]*TextLen\d*(_\d+)?$/.test(key)
      || /MacroLen$/.test(key)
      || /^(MemLen|ByteLen\d+|StringLen|OffsetMemLen|UnitTextLen\d*|FTPPwdLen|PrintStringLen\d*)$/.test(key)
      || /^wCSVLogTitleLen/.test(key)
      || /^wLanguageNameLen/.test(key)
    const n = /^\d+$/.test(val) ? parseInt(val, 10) : -1
    if (isLen && n >= 0 && nx + n <= sec.end && (nx + n === sec.end || body[nx + n] === 0x0d || body[nx + n] === 0x0a)) {
      if (n > 0) blobs[key] = body.subarray(nx, nx + n)
      p = nx + n
      while (p < sec.end && (body[p] === 0x0d || body[p] === 0x0a)) p++
      continue
    }
    p = e + 1
    while (p < sec.end && (body[p] === 0x0d || body[p] === 0x0a)) p++
  }
  return { name: sec.name, kv, blobs, at: sec.start, index: sec.index }
}

for (const sec of sections) {
  if (sec.name === 'Picture') {
    const m = /Size=(\d+)/.exec(bodyStr.slice(sec.contentStart, sec.contentStart + 160))
    if (m) {
      let q0 = sec.contentStart + m.index + m[0].length
      while (body[q0] === 0x0d || body[q0] === 0x0a) q0++
      const size = parseInt(m[1], 10)
      const bank = body.subarray(q0, q0 + size)
      let at = 15, n = 0
      while (at + 60 < bank.length) {
        const hdr = bank.readUInt32LE(at + 4), w = bank.readUInt32LE(at + 8), h = bank.readUInt32LE(at + 12), dl = bank.readUInt32LE(at + 24)
        if (hdr !== 40 || !(w > 0 && w <= 2000 && h > 0 && h <= 2000) || dl !== w * h * 4) break
        pictures.push({ w, h, data: bank.subarray(at + 44, at + 44 + dl) })
        at += 44 + dl; n++
      }
      pictureBytes = bank.length
      pictureCover.push(`${at}/${bank.length}`)
      records.push({ name: 'Picture', kv: [['Size', String(size)], ['Images', String(n)], ['BankBytes', String(bank.length)]], blobs: {}, at: sec.start, index: sec.index })
      continue
    }
  }
  const probe = bodyStr.slice(sec.contentStart, Math.min(sec.end, sec.contentStart + 300))
  const looksIni = probe.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(probe)
  if (/^\d+_[A-Za-z_]+$/.test(sec.name) || (!looksIni && sec.end > sec.contentStart)) {
    binarySections.push({ name: sec.name, bytes: body.subarray(sec.contentStart, sec.end), index: sec.index })
    continue
  }
  records.push(parseIni(sec))
}
let tailBytes = 0
for (const rec of records) if (rec.blobs.$tail) { tailBytes += rec.blobs.$tail.length; tailBlobs.push(rec) }

// ═════════ 4. PNG ═════════
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]) }
function writePng(file, w, h, bgra) {
  const rows = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1); rows[o] = 0
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = o + 1 + x * 4
      rows[d] = bgra[s + 2]; rows[d + 1] = bgra[s + 1]; rows[d + 2] = bgra[s]; rows[d + 3] = bgra[s + 3]
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]))
}

// ═════════ 5. 归组 ═════════
const kvOf = (rec, k) => { const h = rec.kv.find(([x]) => x === k); return h ? h[1] : '' }
const varOf = (rec, k) => { const v = kvOf(rec, k); if (!v || v === 'None') return ''; const m = /@([A-Za-z]\d+)$/.exec(v); return m ? m[1] : cls(v) }
const screens = [], elements = []
let curScreen = null, curEl = null
for (const rec of records) {
  if (rec.name === 'Screen') {
    curScreen = {
      no: screens.length + 1,
      name: rec.blobs.wTextLen ? decodeBytes(rec.blobs.wTextLen) : `画面${screens.length + 1}`,
      title: rec.blobs.wTitleTextLen000 ? decodeBytes(rec.blobs.wTitleTextLen000) : '',
      desc: rec.blobs.wScreenDESCTextLen000 ? decodeBytes(rec.blobs.wScreenDESCTextLen000) : '',
      panel: `${kvOf(rec, 'PanelSizeX')}x${kvOf(rec, 'PanelSizeY')}`,
      doc: `${kvOf(rec, 'DocSizeX')}x${kvOf(rec, 'DocSizeY')}`,
      sub: kvOf(rec, 'IsSubScreen') === '1', elements: [], rec,
    }
    screens.push(curScreen); curEl = null; continue
  }
  if (rec.name === 'Element' && curScreen) {
    curEl = {
      no: curScreen.elements.length + 1, screen: curScreen,
      type: kvOf(rec, 'Type'), subType: kvOf(rec, 'SubType'), parts: kvOf(rec, 'nPartsID'),
      x: kvOf(rec, 'X'), y: kvOf(rec, 'Y'), w: kvOf(rec, 'Width'), h: kvOf(rec, 'Height'),
      read: varOf(rec, 'ReadVar'), write: varOf(rec, 'WriteVar'),
      read2: varOf(rec, 'ReadVar2'), write2: varOf(rec, 'WriteVar2'),
      goto: cls(kvOf(rec, 'GoToScreenName')), visible: kvOf(rec, 'VisibleCondition'),
      desc: rec.blobs.wDescTextLen0 ? decodeBytes(rec.blobs.wDescTextLen0) : '', states: [], rec,
    }
    curScreen.elements.push(curEl); elements.push(curEl); continue
  }
  if (rec.name === 'State' && curEl) {
    curEl.states.push({
      value: kvOf(rec, 'Value'),
      text: rec.blobs.wTextLen0 ? decodeBytes(rec.blobs.wTextLen0) : '',
      font: cls(kvOf(rec, 'FontName0')), size: kvOf(rec, 'FontSize0'),
      fg: kvOf(rec, 'FgColor'), bg: kvOf(rec, 'BgColor'), fontColor: kvOf(rec, 'FontColor'), rec,
    })
  }
}

// ═════════ 6. 地址 / 文字 ═════════
const addrMap = new Map(), refRows = []
const VAR_RE = /@([A-Za-z]\d+)\s*$/
for (const rec of records) for (const [k, v] of rec.kv) {
  const m = VAR_RE.exec(v)
  if (!m) continue
  const side = /^Write/.test(k) || /DisconVar$/.test(k) ? 'w' : /^Read/.test(k) ? 'r' : 'n'
  const a = addrMap.get(m[1]) ?? { read: 0, write: 0, other: 0, where: new Set() }
  if (side === 'w') a.write++; else if (side === 'r') a.read++; else a.other++
  a.where.add(rec.name); addrMap.set(m[1], a)
  refRows.push([m[1], k, v, rec.name])
}
// 内嵌块（宏脚本、元件尾块等）里写的地址也要计入
let macroRefs = 0
const macroFiles = []
for (const rec of records) for (const [k, v] of Object.entries(rec.blobs)) {
  const dec = decodeBytes(v)
  const txt = dec ?? v.toString('latin1')
  if (/Macro|String|Script/i.test(k) && dec !== null) macroFiles.push({ rec, k, txt: dec })
  for (const m of txt.matchAll(/@([A-Za-z]\d+)(?![0-9])/g)) {
    const a = addrMap.get(m[1]) ?? { read: 0, write: 0, other: 0, where: new Set() }
    a.other++; a.where.add(rec.name); addrMap.set(m[1], a); macroRefs++
    refRows.push([m[1], k + '（内嵌块）', `@${m[1]}`, rec.name])
  }
}
const texts = elements.flatMap(el => el.states.map((s, i) => ({ text: s.text, el, i })).filter(t => t.text))

// 宏/脚本块原样导出
mkdirSync(join(outDir, '30-宏'), { recursive: true })
macroFiles.forEach((m, i) => {
  writeFileSync(join(outDir, '30-宏', `${String(i + 1).padStart(3, '0')}-${m.rec.name}-${m.k}.txt`), m.txt, 'utf8')
})

// ═════════ 7. 二进制载荷与内嵌库 ═════════
const binManifest = []
for (const b of binarySections) {
  const magicAt = b.bytes.indexOf(Buffer.from('SQLite format 3'))
  const isSqlite = magicAt >= 0 && magicAt < 64
  const bytes = isSqlite ? b.bytes.subarray(magicAt) : b.bytes
  const file = join(outDir, '91-二进制块', `${String(b.index).padStart(3, '0')}-${b.name}${isSqlite ? '.sqlite' : '.bin'}`)
  writeFileSync(file, bytes)
  binManifest.push([b.name, bytes.length, isSqlite ? 'SQLite 数据库' : '二进制载荷', basename(file)])
  if (!isSqlite) continue
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    const list = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    b.tables = list.map(({ name }) => {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all()
      return { name, cols: rows.length ? Object.keys(rows[0]) : [], rows }
    })
    db.close()
  } catch (e) { b.tables = [] }
}
for (const rec of tailBlobs) {
  const file = join(outDir, '91-二进制块', `${String(rec.index).padStart(3, '0')}-${rec.name}-尾块.bin`)
  writeFileSync(file, rec.blobs.$tail)
  binManifest.push([rec.name, rec.blobs.$tail.length, '记录尾块（未定语义）', basename(file)])
}
for (const b of binarySections) if (b.tables && b.tables.length) {
  const lines = []
  for (const t of b.tables) {
    lines.push(`## ${b.name} / ${t.name}`)
    lines.push(t.cols.join('\t'))
    for (const r of t.rows) lines.push(t.cols.map(c => q(r[c])).join('\t'))
    lines.push('')
  }
  writeFileSync(join(outDir, '17-内嵌库.tsv'), lines.join('\n'), 'utf8')
}

// ═════════ 8. 落盘 ═════════
const stat = {
  源文件: basename(dpaPath), 文件大小: raw.length, 缩略图字节: gz, 文件头: fileHeader,
  解压后: payload.length, 正文字节: body.length, 正文起点: bodyStart,
  节数: sections.length, 记录数: records.length,
  键值对数: records.reduce((a, r) => a + r.kv.length, 0),
  内嵌块数: records.reduce((a, r) => a + Object.keys(r.blobs).filter(k => k !== '$tail').length, 0),
  内嵌块字节: records.reduce((a, r) => a + Object.entries(r.blobs).filter(([k]) => k !== '$tail').reduce((x, [, v]) => x + v.length, 0), 0),
  记录尾块数: tailBlobs.length, 记录尾块字节: tailBytes,
  宏块数: macroFiles.length, 内嵌块内地址引用: macroRefs,
  二进制节: binarySections.map(b => `${b.name}:${b.bytes.length}`),
  内嵌库: binarySections.filter(b => b.tables && b.tables.length).map(b => `${b.name}:${b.tables.length}表`),
  画面数: screens.length, 元件数: elements.length,
  状态数: elements.reduce((a, e) => a + e.states.length, 0),
  地址数: addrMap.size, 文字条数: texts.length,
  图片数: pictures.length, 图片库字节: pictureBytes,
  头部残留字节: headBytes, 未解析残留字节: headBytes,
}
writeFileSync(join(outDir, '08-统计.json'), JSON.stringify(stat, null, 1), 'utf8')

const tsv = rows => rows.map(r => r.map(q).join('\t')).join('\n') + '\n'
writeFileSync(join(outDir, '10-画面.tsv'), tsv([
  ['画面号', '画面名', '标题', '面板', '画布', '子画面', '元件数'],
  ...screens.map(s => [s.no, s.name, s.title, s.panel, s.doc, s.sub ? '是' : '', s.elements.length]),
]), 'utf8')
writeFileSync(join(outDir, '11-元件.tsv'), tsv([
  ['画面', '元件', 'Type', 'SubType', '部件号', 'X', 'Y', '宽', '高', '显示文字', '读地址', '写地址', '读地址2', '写地址2', '跳转画面', '可见条件'],
  ...elements.map(el => [el.screen.name, el.no, el.type, el.subType, el.parts, el.x, el.y, el.w, el.h,
    el.states.map(s => s.text).filter(Boolean)[0] ?? '', el.read, el.write, el.read2, el.write2, el.goto, el.visible]),
]), 'utf8')
writeFileSync(join(outDir, '12-状态.tsv'), tsv([
  ['画面', '元件', '状态序', 'Value', '文字', '字体', '字号', '前景', '背景', '文字色'],
  ...elements.flatMap(el => el.states.map((st, i) => [el.screen.name, el.no, i, st.value, st.text, st.font, st.size, st.fg, st.bg, st.fontColor])),
]), 'utf8')
writeFileSync(join(outDir, '13-地址表.tsv'), tsv([
  ['地址', '屏读', '屏写', '其它引用', '出现节'],
  ...[...addrMap.entries()].sort().map(([a, v]) => [a, v.read, v.write, v.other, [...v.where].join(' ')]),
]), 'utf8')
writeFileSync(join(outDir, '14-文字.tsv'), tsv([['文字', '画面', '元件', '状态序'], ...texts.map(t => [t.text, t.el.screen.name, t.el.no, t.i])]), 'utf8')
writeFileSync(join(outDir, '16-地址引用明细.tsv'), tsv([['地址', '键名', '原值', '所在节'], ...refRows]), 'utf8')
writeFileSync(join(outDir, '18-二进制清单.tsv'), tsv([['来源节', '字节', '类型', '文件'], ...binManifest]), 'utf8')

// 口令与权限汇总（密码本、画面口令、子宏口令、FTP 口令、元件安全等级）
const pwdRows = []
for (const s of screens) pwdRows.push(['画面口令', s.name, kvOf(s.rec, 'ScreenPassword') || '（空）', '屏上该画面是否需要口令'])
const subRec = records.find(r => r.name === 'SubMacro')
if (subRec) {
  const pw = subRec.kv.filter(([k]) => /^SubMacroPWD/.test(k))
  const dist = new Map()
  for (const [, v] of pw) dist.set(v, (dist.get(v) || 0) + 1)
  const protect = subRec.kv.filter(([k, v]) => /^SubMacroProtect/.test(k) && v !== '0')
  pwdRows.push(['子宏口令', 'SubMacroPWD001–1024', `${pw.length} 条：${[...dist].map(([v, n]) => `${v}×${n}`).join(' ')}`, '子宏是否加锁、口令是什么'])
  pwdRows.push(['子宏保护', 'SubMacroProtect001–1024', protect.length ? `${protect.length} 条已加保护` : '全部未加保护', ''])
}
for (const rec of records) {
  for (const [k, v] of rec.kv) {
    if (/^(FTPPwd|Password|Pwd)$|PwdLen$|PasswordLen$/.test(k) && v && rec.name !== 'SubMacro') pwdRows.push([`${rec.name}`, k, /Len$/.test(k) ? `长度 ${v}` : v, ''])
  }
  for (const [k, b] of Object.entries(rec.blobs)) {
    if (/Pwd|Password/i.test(k)) pwdRows.push([`${rec.name}`, k, decodeBytes(b) ?? `${b.length} 字节二进制`, '内嵌块'])
  }
}
const secDist = new Map()
for (const el of elements) {
  const v = kvOf(el.rec, 'SetLowSecurity')
  if (v !== '') secDist.set(v, (secDist.get(v) || 0) + 1)
}
for (const [v, n] of [...secDist].sort()) pwdRows.push(['元件权限', 'SetLowSecurity', `${n} 个元件`, `最低安全等级 ${v}`])
for (const b of binarySections) {
  for (const t of (b.tables ?? [])) {
    if (!/PASSWORD/i.test(t.name)) continue
    const col = t.cols.join('/')
    pwdRows.push(['内嵌库', `${b.name}.${t.name}`, `${t.rows.length} 行`, col])
  }
}
writeFileSync(join(outDir, '19-口令与权限.tsv'), tsv([['来源', '键或表', '值', '说明'], ...pwdRows]), 'utf8')


const devRec = records.find(r => r.name === 'Device')
const devRows = []
if (devRec) for (const [k] of devRec.kv) {
  const m = /^MemAddr(\d+)$/.exec(k)
  if (m) devRows.push([m[1], kvOf(devRec, 'Interface' + m[1]), kvOf(devRec, 'StartAddr' + m[1]), kvOf(devRec, 'Length' + m[1]), kvOf(devRec, 'MemAddr' + m[1])])
}
writeFileSync(join(outDir, '15-变量映射.tsv'), tsv([['编号', '接口', '起始地址', '长度', '屏内地址段'], ...devRows]), 'utf8')
pictures.forEach((pic, i) => writePng(join(outDir, '20-图片', `pic_${String(i + 1).padStart(2, '0')}_${pic.w}x${pic.h}.png`), pic.w, pic.h, pic.data))

const jsonl = records.map(rec => {
  const blobs = {}
  for (const [k, v] of Object.entries(rec.blobs)) {
    const txt = decodeBytes(v)
    blobs[k] = txt !== null && txt.length <= 4000 ? { bytes: v.length, text: txt } : { bytes: v.length, hex: v.subarray(0, 48).toString('hex') }
  }
  const kv = {}
  for (const [k, v] of rec.kv) kv[k] = /[\x80-\xff]/.test(v) ? cls(v) : v
  return JSON.stringify({ name: rec.name, at: rec.at, kv, blobs })
})
writeFileSync(join(outDir, '90-全量记录.jsonl'), jsonl.join('\n') + '\n', 'utf8')

const elByType = new Map()
for (const el of elements) { const k = `Type${el.type}/SubType${el.subType}`; elByType.set(k, (elByType.get(k) || 0) + 1) }
const addrTop = [...addrMap.entries()].sort((a, b) => (b[1].read + b[1].write) - (a[1].read + a[1].write)).slice(0, 20)
const md = [
  `# ${basename(dpaPath, extname(dpaPath))} · HMI 解码报告（台达 DIAScreen .dpa）`,
  '', `文件头: ${fileHeader}`, '',
  '## 规模', '',
  `- 文件 ${stat.文件大小} 字节 → 缩略图 ${stat.缩略图字节} 字节 + gzip 体；解压后 ${stat.解压后} 字节；正文 ${stat.正文字节} 字节`,
  `- 节 ${stat.节数} 个、记录 ${stat.记录数} 条、键值 ${stat.键值对数} 对、内嵌块 ${stat.内嵌块数} 个（${stat.内嵌块字节} 字节）、记录尾块 ${stat.记录尾块数} 个（${stat.记录尾块字节} 字节）`,
  `- 二进制节: ${stat.二进制节.join(' ') || '无'}；内嵌库: ${stat.内嵌库.join(' ') || '无'}`,
  `- 画面 ${stat.画面数}、元件 ${stat.元件数}、状态 ${stat.状态数}、地址 ${stat.地址数}、文字 ${stat.文字条数}、图片 ${stat.图片数}（${stat.图片库字节} 字节，覆盖 ${pictureCover.join(',')}）`,
  `- 宏块 ${stat.宏块数} 个（宏内地址引用 ${stat.内嵌块内地址引用} 处）`,
  `- 头部残留 ${stat.头部残留字节} 字节（文件头与正文起点之间）`,
  '', '## 画面', '', '| # | 画面名 | 标题 | 尺寸 | 元件 |', '|---|---|---|---|---|',
  ...screens.map(s => `| ${s.no} | ${s.name} | ${s.title || ''} | ${s.doc} | ${s.elements.length} |`),
  '', '## 元件类型分布', '',
  ...[...elByType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `- ${k}: ${v}`),
  '', '## 地址（引用次数前 20）', '', '| 地址 | 屏读 | 屏写 | 其它 |', '|---|---|---|---|',
  ...addrTop.map(([a, v]) => `| ${a} | ${v.read} | ${v.write} | ${v.other} |`),
  '', '## 产物', '',
  '- `10-画面.tsv` / `11-元件.tsv` / `12-状态.tsv`：画面、元件、状态（文字、配色、字体）',
  '- `13-地址表.tsv` / `16-地址引用明细.tsv` / `15-变量映射.tsv`：地址统计与逐条引用',
  '- `14-文字.tsv`：全部文字　`20-图片/`：图片库 PNG　`17-内嵌库.tsv`：内嵌 SQLite 表内容　`30-宏/`：宏与脚本原文',
  '- `19-口令与权限.tsv`：画面口令、子宏口令、FTP 口令、元件安全等级、内嵌库口令表清单',
  '- `18-二进制清单.tsv` + `91-二进制块/`：其余二进制载荷（含 SQLite 库文件）',
  '- `90-全量记录.jsonl`：逐条记录全部键值与内嵌块（不丢字段）　`08-统计.json`：规模数字',
].join('\n')
writeFileSync(join(outDir, 'HMI解码报告.md'), md, 'utf8')

console.log([
  `已解码: ${basename(dpaPath)}`,
  `画面 ${stat.画面数} ｜ 元件 ${stat.元件数} ｜ 状态 ${stat.状态数} ｜ 地址 ${stat.地址数} ｜ 文字 ${stat.文字条数} ｜ 图片 ${stat.图片数}`,
  `节 ${stat.节数} ｜ 记录 ${stat.记录数} ｜ 键值 ${stat.键值对数} ｜ 内嵌块 ${stat.内嵌块数} ｜ 内嵌库 ${stat.内嵌库.join(',') || '无'}`,
  `头部残留 ${stat.头部残留字节} 字节 ｜ 图片库覆盖 ${pictureCover.join(',')}`,
  `产物目录: ${outDir}`,
].join('\n'))
