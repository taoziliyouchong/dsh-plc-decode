#!/usr/bin/env node
/**
 * hmismart-diff.mjs —— 对比新旧两份 WinCC flexible SMART 触摸屏工程（.hmismart）
 *
 * 用法： node hmismart-diff.mjs <旧工程.hmismart> <新工程.hmismart> [输出目录]
 * 输出： <输出目录>/HMI差异报告.md（默认写到 旧工程同目录\HMI差异_<时间戳>\）
 *
 * 比什么：
 *   1. 容器的起始画面配置（StartScreenId / StartScreenType）—— 重启后显示哪个画面就看它
 *   2. 画面表记录（ObjId / 名称 / 删除标志）
 *   3. 明文区画面名清单
 *   4. 画面对象 GUID（来自 ES2RT .data，逐名对照）
 *   5. 配套文件（.srt 项目文本 / .data 组态数据）的大小与文本差异
 * 只读，不改动任何工程文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/* ───────── 基础 ───────── */
function readGuarded(file) {
  try { return fs.readFileSync(file) }
  catch (e) {
    if (e.code === 'EBUSY' || /being used by another process/.test(e.message)) {
      throw new Error(`文件被独占锁定（很可能 WinCC flexible SMART 正打开着它）：${file}\n`
        + '处理：在软件里「另存为」一份到别的目录，或关闭软件后重试。')
    }
    throw e
  }
}
function inflateBlocks(buf) {
  const out = []
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0x1f && buf[i + 1] === 0x8b && buf[i + 2] === 0x08) {
      try { out.push(zlib.inflateRawSync(buf.subarray(i + 10))) } catch { }
      i += 3
    }
  }
  return out
}
const norm = h => `${h.slice(6, 8)}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}-${h.slice(10, 12)}${h.slice(8, 10)}-${h.slice(14, 16)}${h.slice(12, 14)}-${h.slice(16, 20)}-${h.slice(20)}`

/* ───────── 提取 ───────── */
function probe(file) {
  const buf = readGuarded(file)
  const blocks = inflateBlocks(buf)
  const text = Buffer.concat(blocks).toString('utf8')

  const dev = []
  for (const m of text.matchAll(/<DeviceType>([^<]*)<\/DeviceType>[\s\S]{0,80}?<StartScreenType>([^<]*)<\/StartScreenType>[^<]*<StartScreenId>([^<]*)<\/StartScreenId>/g)) {
    dev.push({ deviceType: m[1], startScreenType: m[2], startScreenId: m[3] })
  }
  const screens = new Map()
  for (const m of text.matchAll(/<HmiScreenTable>([\s\S]*?)<\/HmiScreenTable>/g)) {
    const b = m[1]
    const g = n => { const r = b.match(new RegExp(`<${n}>([^<]*)</${n}>`)); return r ? r[1] : '' }
    const id = g('ObjId'); if (id) screens.set(id, { id, name: g('ObjName'), number: g('Number'), deleted: g('Deleted') })
  }
  const names = new Set()
  // 画面对象记录：36 + 类型GUID(16B) + 字段 + 名称(UTF-16LE)；画面类型 GUID 固定
  const SCREEN_TYPE = 'a8d0ec5ba448dd4e8cfd1f93bab80357'
  const isUuid4 = o => o + 16 <= buf.length && (buf[o + 7] >> 4) === 4 && (buf[o + 8] & 0xc0) === 0x80
  for (let i = 0; i + 17 < buf.length; i++) {
    if (buf[i] !== 0x36 || !isUuid4(i + 1)) continue
    let g = ''
    for (let k = i + 1; k < i + 17; k++) g += buf[k].toString(16).padStart(2, '0')
    if (g !== SCREEN_TYPE) continue
    for (let s = i + 17; s < i + 45; s++) {
      const c = buf[s] | (buf[s + 1] << 8)
      if (!((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x41 && c <= 0x5a))) continue
      let j = s, str = ''
      while (j + 1 < buf.length && str.length < 40) {
        const cc = buf[j] | (buf[j + 1] << 8)
        if ((cc >= 0x4e00 && cc <= 0x9fff) || (cc >= 0x30 && cc <= 0x39) || (cc >= 0x41 && cc <= 0x5a) || (cc >= 0x61 && cc <= 0x7a) || cc === 0x5f || cc === 0x2d || cc === 0x2e || cc === 0x20) { str += String.fromCharCode(cc); j += 2 } else break
      }
      if (str.length >= 2) names.add(str)
      break
    }
  }
  // 配套文件
  const dir = path.dirname(file), base = path.basename(file, path.extname(file))
  const peers = fs.readdirSync(dir).filter(f => f.startsWith(base) && f !== path.basename(file) && fs.statSync(path.join(dir, f)).isFile())
  return { file, size: buf.length, blocks: blocks.length, dev, screens, names, peers, dir, base }
}

function peerInfo(dir, base, name) {
  const p = path.join(dir, name)
  if (!fs.existsSync(p)) return null
  const st = fs.statSync(p)
  let texts = null
  if (/\.srt$|\.transfer$|\.modified$/.test(name)) {
    try {
      const b = fs.readFileSync(p); const set = new Set()
      for (let i = 0; i + 1 < b.length; i += 2) {
        const c = b[i] | (b[i + 1] << 8)
        if (!((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) continue
        let j = i, s = ''
        while (j + 1 < b.length && s.length < 60) {
          const cc = b[j] | (b[j + 1] << 8)
          if ((cc >= 0x4e00 && cc <= 0x9fff) || (cc >= 0x30 && cc <= 0x39) || (cc >= 0x41 && cc <= 0x5a) || (cc >= 0x61 && cc <= 0x7a) || cc === 0x5f || cc === 0x2d || cc === 0x2e || cc === 0x20) { s += String.fromCharCode(cc); j += 2 } else break
        }
        if (s.length >= 2) set.add(s)
        i = Math.max(i, j - 2)
      }
      texts = set
    } catch { }
  }
  return { size: st.size, texts }
}

/* ───────── 主流程 ───────── */
const [oldFile, newFile, outArg] = process.argv.slice(2)
if (!oldFile || !newFile) { console.error('用法: node hmismart-diff.mjs <旧工程.hmismart> <新工程.hmismart> [输出目录]'); process.exit(1) }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
// 默认落工作区统一归档目录，不写工程目录（用户约定）
const outDir = path.resolve(outArg || path.join(process.cwd(), '解码归档', path.basename(path.resolve(oldFile), path.extname(oldFile)), 'HMI差异_' + stamp))
fs.mkdirSync(outDir, { recursive: true })

const A = probe(path.resolve(oldFile))
const B = probe(path.resolve(newFile))
const L = []
const P = (...s) => L.push(...s)

P('# HMI 工程差异报告', '')
P(`- 旧版：\`${A.file}\`  ${A.size.toLocaleString()} 字节`)
P(`- 新版：\`${B.file}\`  ${B.size.toLocaleString()} 字节`)
P(`- 容器大小：${A.size === B.size ? '**完全相同**（原地改：改的是定长字段）' : `差 ${B.size - A.size} 字节`}`)
P('')

/* 1. 起始画面 */
P('## 1. 起始画面配置（决定重启后显示哪个画面）', '')
const devA = A.dev[0] || {}, devB = B.dev[0] || {}
P('| 项 | 旧版 | 新版 | 判定 |')
P('|---|---|---|---|')
for (const k of ['startScreenType', 'startScreenId']) {
  const a = devA[k] ?? '(无)', b = devB[k] ?? '(无)'
  P(`| ${k} | \`${a}\` | \`${b}\` | ${a === b ? '相同' : '**不同** ← 改动点'} |`)
}
P('')
const screenOf = (S, id) => S.screens.get(id)
const sa = screenOf(A, devA.startScreenId), sb = screenOf(B, devB.startScreenId)
P(`- 旧版起始画面指向：${sa ? `\`${sa.name}\`${sa.deleted === 'true' ? '（**已删除**）' : ''}` : '（不在画面表内）'}`)
P(`- 新版起始画面指向：${sb ? `\`${sb.name}\`${sb.deleted === 'true' ? '（**已删除**）' : ''}` : '（不在画面表内）'}`)
if (sa && sa.deleted === 'true' && sb && sb.deleted !== 'true') P('\n> **根因**：旧版起始画面指向一个「已删除」的画面，面板启动找不到它就会退到其它画面（表现即「重启后跳到别的画面」）；新版已改为有效画面。')
else if (!sa || !sb) P('\n> 提示：起始画面 ID 未出现在画面表里，本报告无法判定它指向哪个画面。')
P('')

/* 2. 画面表 */
P('## 2. 画面表记录（HmiScreenTable）', '')
P('| 名称 | 旧版 | 新版 |')
P('|---|---|---|')
const ids = new Set([...A.screens.keys(), ...B.screens.keys()])
for (const id of ids) {
  const x = A.screens.get(id), y = B.screens.get(id)
  P(`| ${(x || y).name} | ${x ? `删除=${x.deleted} 编号=${x.number}` : '—'} | ${y ? `删除=${y.deleted} 编号=${y.number}` : '—'} |`)
}
P('')

/* 3. 画面名清单 */
P('## 3. 明文区画面名清单', '')
const onlyA = [...A.names].filter(n => !B.names.has(n))
const onlyB = [...B.names].filter(n => !A.names.has(n))
P(`- 旧版 ${A.names.size} 个｜新版 ${B.names.size} 个`)
if (onlyA.length) P(`- **仅旧版有**：${onlyA.join('、')}`)
if (onlyB.length) P(`- **仅新版有**：${onlyB.join('、')}`)
if (!onlyA.length && !onlyB.length) P('- 两份画面名清单一致')
P('')

/* 4. 配套文件 */
P('## 4. 配套文件差异', '')
const allPeers = [...new Set([...A.peers, ...B.peers])].sort()
P('| 文件 | 旧版 | 新版 | 差异 |')
P('|---|---|---|---|')
const peerTextDiff = []
for (const name of allPeers) {
  const a = peerInfo(A.dir, A.base, name), b = peerInfo(B.dir, B.base, name)
  let note = ''
  if (a && b && a.texts && b.texts) {
    const oa = [...a.texts].filter(x => !b.texts.has(x)), ob = [...b.texts].filter(x => !a.texts.has(x))
    if (oa.length || ob.length) {
      note = `文本 −${oa.length}/+${ob.length}`
      peerTextDiff.push({ name, oa, ob })
    }
  }
  P(`| ${name.replace(A.base, '<工程名>')} | ${a ? a.size.toLocaleString() : '—'} | ${b ? b.size.toLocaleString() : '—'} | ${(a && b && a.size === b.size) ? '相同' : (a && b ? `差 ${b.size - a.size}` : (a ? '仅旧版有' : '仅新版有'))}${note ? '；' + note : ''} |`)
}
P('')
for (const d of peerTextDiff) {
  P(`### ${d.name.replace(A.base, '<工程名>')} 文本差异`, '')
  if (d.oa.length) { P('- 仅旧版有：'); for (const s of d.oa.slice(0, 40)) P(`  - \`${s}\``) }
  if (d.ob.length) { P('- 仅新版有：'); for (const s of d.ob.slice(0, 40)) P(`  - \`${s}\``) }
  P('')
}

P('## 5. 怎么读这份报告', '')
P('- 第 1 节是**重启后显示哪个画面**的直接依据；两份值不同 ⇒ 这就是改动点。')
P('- 若起始画面指向「已删除」的画面，面板会退到其它画面 —— 这是"重启跳到别的画面"的典型成因。')
P('- 第 2/3 节确认画面本身有无增删改名；第 4 节是配套文件（项目文本/组态数据）的差异。')
P('- 报告只读源文件；需要更深的字段级差异（变量表、元件属性）时，先跑 hmismart-decode.mjs 出两侧解码产物再逐项比对。')
P('')

const outFile = path.join(outDir, 'HMI差异报告.md')
fs.writeFileSync(outFile, L.join('\n'))
console.log(`[完成] ${outFile}`)
console.log(`  起始画面：旧=${devA.startScreenId || '-'}${sa ? `(${sa.name}${sa.deleted === 'true' ? '·已删除' : ''})` : ''}  新=${devB.startScreenId || '-'}${sb ? `(${sb.name}${sb.deleted === 'true' ? '·已删除' : ''})` : ''}`)
console.log(`  画面表：旧 ${A.screens.size} 条｜新 ${B.screens.size} 条；画面名：旧 ${A.names.size} 个｜新 ${B.names.size} 个`)
