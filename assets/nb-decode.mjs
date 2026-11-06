// nb-decode.mjs —— 欧姆龙 NB-Designer 工程解码（.nbp + HMI*/HMI*.whe）
//
// 格式：两者都是纯 XML（不是二进制、不是压缩）。
//   .nbp      = 工程索引：PLC 连接、串口参数、HMI 引用、地址标签、PLC 控制对象
//   HMI*.whe  = 画面内容：<Window ProjectID Name ...> 每个画面，<Part Type Name> 每个控件，
//               <Address ...><AddressType>LW</AddressType><AddressValue>9190</AddressValue>
// 用法：node nb-decode.mjs <工程.nbp> [输出目录]
import fs from 'node:fs'
import path from 'node:path'

function attr(s, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s)
  return m ? m[1] : ''
}
function num(block, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)
  return m ? m[1] : ''
}

function main() {
  const file = process.argv[2]
  if (!file) { console.error('用法: node nb-decode.mjs <工程.nbp> [输出目录]'); process.exit(2) }
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) { console.error(`文件不存在: ${file}`); process.exit(2) }
  const head = fs.readFileSync(abs, 'utf8').slice(0, 200)
  if (!head.includes('<?xml')) { console.error('不是 NB-Designer 工程（.nbp 应为 XML）'); process.exit(3) }

  const base = path.dirname(abs)
  const outDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(base, '解码归档', path.basename(abs, '.nbp'))
  fs.mkdirSync(outDir, { recursive: true })

  const nbp = fs.readFileSync(abs, 'utf8')
  const projName = attr(nbp.slice(0, 300), 'Name') || path.basename(abs, '.nbp')
  const plcs = [...nbp.matchAll(/<PLC\s+([^>]*)>/g)].map((m) => ({ raw: m[1], name: attr(m[1], 'Name'), sys: attr(m[1], 'SystemID') }))
  const hmis = [...nbp.matchAll(/<HMI\s+URL="([^"]+)"/g)].map((m) => m[1].replace(/\\/g, '/'))
  const links = [...nbp.matchAll(/<Connector Name="([^"]*)"[^>]*Type="(\d)"/g)].map((m) => ({ name: m[1], type: m[2] }))

  // 画面与控件：遍历每个 HMI 的 .whe
  const windows = []
  for (const rel of hmis) {
    const whePath = path.join(base, rel)
    if (!fs.existsSync(whePath)) continue
    const whe = fs.readFileSync(whePath, 'utf8')
    for (const wm of whe.matchAll(/<Window\s+ProjectID="(\d+)"\s+Name="([^"]*)"([^>]*)>/g)) {
      const pid = wm[1], name = wm[2]
      const start = wm.index
      const next = whe.indexOf('<Window ', start + 10)
      const block = whe.slice(start, next > 0 ? next : undefined)
      const parts = []
      for (const pm of block.matchAll(/<Part\s+Type="([^"]*)"\s+[^>]*?Name="([^"]*)"([\s\S]{0,4000}?)<\/Part>/g)) {
        const type = pm[1], pname = pm[2], body = pm[3]
        const addrType = num(body, 'AddressType')
        const addrVal = num(body, 'AddressValue')
        parts.push({ type, name: pname, addr: addrType ? `${addrType}${addrVal}` : '' })
      }
      windows.push({ pid: Number(pid), name, file: rel, parts })
    }
  }
  windows.sort((a, b) => a.pid - b.pid)

  const L = []
  L.push(`# ${projName} · NB-Designer 解码`)
  L.push('')
  L.push(`- 源文件: ${path.basename(abs)}（${(fs.statSync(abs).size / 1024).toFixed(1)} KB，XML）`)
  L.push(`- 规模: PLC 连接 ${plcs.length} / 画面 ${windows.length} / 控件 ${windows.reduce((n, w) => n + w.parts.length, 0)}`)
  if (hmis.length) L.push(`- 画面文件: ${hmis.join(', ')}`)
  L.push('')
  L.push('## PLC 连接')
  L.push('')
  L.push('| 名字 | 系统 ID |')
  L.push('|---|---|')
  for (const p of plcs) L.push(`| ${p.name} | ${p.sys} |`)
  if (links.length) {
    L.push('')
    L.push('## 连接器')
    L.push('')
    L.push('| 名字 | 类型 |')
    L.push('|---|---|')
    for (const l of links) L.push(`| ${l.name} | ${l.type} |`)
  }
  L.push('')
  L.push('## 画面与控件')
  L.push('')
  L.push('| 画面 ID | 画面名 | 控件数 | 控件类型分布 |')
  L.push('|---|---|---|---|')
  for (const w of windows) {
    const byType = {}
    for (const p of w.parts) byType[p.type] = (byType[p.type] || 0) + 1
    const dist = Object.entries(byType).map(([k, v]) => `${k}×${v}`).join('，') || '—'
    L.push(`| ${w.pid} | ${w.name} | ${w.parts.length} | ${dist} |`)
  }
  const withAddr = windows.flatMap((w) => w.parts.filter((p) => p.addr).map((p) => ({ w: w.name, ...p })))
  if (withAddr.length) {
    L.push('')
    L.push('## 带地址的控件（前 60）')
    L.push('')
    L.push('| 画面 | 控件 | 类型 | 地址 |')
    L.push('|---|---|---|---|')
    for (const p of withAddr.slice(0, 60)) L.push(`| ${p.w} | ${p.name} | ${p.type} | ${p.addr} |`)
  }
  fs.writeFileSync(path.join(outDir, '解码报告.md'), L.join('\n') + '\n', 'utf8')
  fs.writeFileSync(path.join(outDir, '画面控件.json'), JSON.stringify({ projName, plcs, hmis, windows }, null, 1), 'utf8')
  console.log(`OK ${projName} → ${outDir}`)
  console.log(`   PLC ${plcs.length} / 画面 ${windows.length} / 控件 ${windows.reduce((n, w) => n + w.parts.length, 0)}`)
}

main()
