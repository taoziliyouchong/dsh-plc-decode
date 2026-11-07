/**
 * S7-200 / S7-200 SMART 语句表（STL）→ 文字梯形图 + 机械讲解（纯函数，零依赖）
 *
 * 认得的写法：
 *   触点      LD/LDN、A/AN、O/ON、NOT
 *   逻辑堆栈  ALD、OLD、LPS、LRD、LPP
 *   边沿      EU（画成 ┤P├）、ED（画成 ┤N├）
 *   比较触点  西门子写法 LDD=／AD<>／OW>… 与梯形图写法 ==I／<D／>=R… 都认
 *   输出      =（线圈）、S／R（置位复位，可带个数）、CALL（子程序与库块）
 *   指令盒    MOV_、TON/TOF、CTU/CTD、INC/DEC、算术、移位… 一律按"盒＋引脚"画
 *
 * 风格与 ladder 一致：触点与导线在左、盒画方框、引脚列两侧、值写在导线上。
 * 认不出的写法不猜：按盒原样画，并在讲解里标"未识别"。
 */

import { dw } from './ladder-render.mjs'

// ───────────────────────── 解析 ─────────────────────────

/** STL 文本 → 网络数组 [{ no, title, comments[], instrs[] }] */
export function parseStl(text) {
  const nets = []
  let cur = null
  const open = (no, title = '') => { cur = { no, title, comments: [], instrs: [] }; nets.push(cur); return cur }
  for (const raw0 of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const raw = raw0.trim()
    if (!raw) continue
    const nh = raw.match(/^(?:NETWORK|网络)\s*(\d+)\s*(.*)$/i)
    if (nh) { open(Number(nh[1]), nh[2].trim()); continue }
    if (raw.startsWith('//')) { (cur ?? open(nets.length + 1)).comments.push(raw.replace(/^\/\/+\s?/, '')); continue }
    const body = raw.replace(/^[A-Za-z_][\w.]*:\s*/, '')           // 去掉行标号
    const mm = body.match(/^(\S+)\s*(.*)$/)
    if (!mm) continue
    const m = mm[1].toUpperCase()
    const rest = mm[2].split(';')[0].trim()                        // 去掉行末注释
    const ops = rest ? rest.split(',').map((s) => s.trim()).filter((s) => s !== '') : []
    ;(cur ?? open(nets.length + 1)).instrs.push({ m, ops, raw })
  }
  return nets
}

// ───────────────────────── 指令表 ─────────────────────────

const CONTACT = { LD: 'no', LDN: 'nc', A: 'no', AN: 'nc', O: 'no', ON: 'nc' }

/** 比较触点的两种写法：LDD= / AD<> / OW> 与 ==I / <D / >=R */
function matchCompare(m) {
  let x = m.match(/^(LD|A|O)?(==|<>|>=|<=|>|<)([BWDRIL]?)$/)
  if (x) return { pre: x[1] ?? '', op: x[2], type: x[3] ?? '' }
  x = m.match(/^(LD|A|O)([BWDRIL])(=|<>|>=|<=|>|<)$/)
  if (x) return { pre: x[1], op: x[3], type: x[2] }
  return null
}

/** 常见指令盒的引脚名；认不出就用 IN1/IN2/…/OUT 的中性名 */
const BOX_PINS = {
  MOV_B: ['IN', 'OUT'], MOV_W: ['IN', 'OUT'], MOV_DW: ['IN', 'OUT'], MOV_R: ['IN', 'OUT'],
  TON: ['IN', 'PT'], TOF: ['IN', 'PT'], TONR: ['IN', 'PT'],
  CTU: ['CU', 'PV'], CTD: ['CD', 'PV'], CTUD: ['CU', 'PV'],
  INC_B: ['IN', 'OUT'], INC_W: ['IN', 'OUT'], INC_DW: ['IN', 'OUT'],
  DEC_B: ['IN', 'OUT'], DEC_W: ['IN', 'OUT'], DEC_DW: ['IN', 'OUT'],
  '+I': ['IN1', 'OUT'], '-I': ['IN1', 'OUT'], '*I': ['IN1', 'OUT'], '/I': ['IN1', 'OUT'],
  '+D': ['IN1', 'OUT'], '-D': ['IN1', 'OUT'], '*D': ['IN1', 'OUT'], '/D': ['IN1', 'OUT'],
  '+R': ['IN1', 'OUT'], '-R': ['IN1', 'OUT'], '*R': ['IN1', 'OUT'], '/R': ['IN1', 'OUT'],
  SHL_B: ['IN', 'N', 'OUT'], SHL_W: ['IN', 'N', 'OUT'], SHL_DW: ['IN', 'N', 'OUT'],
  SHR_B: ['IN', 'N', 'OUT'], SHR_W: ['IN', 'N', 'OUT'], SHR_DW: ['IN', 'N', 'OUT'],
  WAND_W: ['IN1', 'IN2', 'OUT'], WOR_W: ['IN1', 'IN2', 'OUT'], WXOR_W: ['IN1', 'IN2', 'OUT'],
  B_I: ['IN', 'OUT'], I_B: ['IN', 'OUT'], I_DI: ['IN', 'OUT'], DI_I: ['IN', 'OUT'],
}
/** 末位引脚是"输出"（画在盒右侧）的指令 */
const RIGHT_PIN = /^(MOV_|INC_|DEC_|SHL_|SHR_|WAND_|WOR_|WXOR_|B_I|I_B|I_DI|DI_I|[+\-*/][IDRBW])/

// ───────────────────────── 建逻辑树 ─────────────────────────

const contactNode = (addr, nc) => ({ t: 'contact', label: addr ?? '', sym: nc ? '┤/├' : '┤ ├' })

/** 一条网络的指令流 → 梯级数组 [{ logic, out }] */
export function buildRungs(net) {
  const stack = []
  const rungs = []
  const top = () => stack[stack.length - 1]
  const setTop = (v) => { stack[stack.length - 1] = v }
  const both = (fn) => { const b = stack.pop(); const a = stack.pop(); stack.push(fn(a, b)) }

  for (const { m, ops } of net.instrs ?? []) {
    if (m in CONTACT) {
      if (m === 'LD' || m === 'LDN') stack.push(contactNode(ops[0], m === 'LDN'))
      else if (m === 'A' || m === 'AN') setTop({ t: 'and', a: top(), b: contactNode(ops[0], m === 'AN') })
      else setTop({ t: 'or', kids: [top(), contactNode(ops[0], m === 'ON')] })
      continue
    }
    if (m === 'ALD') { both((a, b) => ({ t: 'and', a, b })); continue }
    if (m === 'OLD') { both((a, b) => ({ t: 'or', kids: [a, b] })); continue }
    if (m === 'LPS') { stack.push(top()); continue }
    if (m === 'LRD') { setTop(stack[stack.length - 2] ?? top()); continue }
    if (m === 'LPP') { stack.pop(); continue }
    if (m === 'EU' || m === 'ED') { setTop({ t: 'edge', kind: m === 'EU' ? 'P' : 'N', a: top() }); continue }
    if (m === 'NOT') { setTop({ t: 'not', a: top() }); continue }

    const cmp = matchCompare(m)
    if (cmp) {
      const op = cmp.op === '=' ? '==' : cmp.op
      const node = { t: 'contact', label: ops[0] ?? '', sym: `┤${op}${cmp.type} ${ops[1] ?? ''}├`, cmpOp: cmp.op, cmpTo: ops[1] ?? '' }
      if (cmp.pre === 'LD' || !stack.length) stack.push(node)
      else if (cmp.pre === 'O') setTop({ t: 'or', kids: [top(), node] })
      else setTop({ t: 'and', a: top(), b: node })
      continue
    }

    const logic = top() ?? null
    if (m === '=') rungs.push({ logic, out: { kind: 'coil', addr: ops[0] ?? '' } })
    else if (m === 'S' || m === 'R') rungs.push({ logic, out: { kind: m === 'S' ? 'set' : 'reset', addr: ops[0] ?? '', n: ops[1] } })
    else if (m === 'CALL') rungs.push({ logic, out: { kind: 'call', name: ops[0] ?? '', args: ops.slice(1) } })
    else rungs.push({ logic, out: { kind: 'box', m, ops } })
  }
  return rungs
}

// ───────────────────────── 画：逻辑树 → 多行块 ─────────────────────────

function rNode(n) {
  if (!n) return { lines: [''], mid: 0, w: 0 }
  if (n.t === 'contact') { const s = `${n.label} ${n.sym}`.trim(); return { lines: [s], mid: 0, w: dw(s) } }
  if (n.t === 'not') {
    const A = rNode(n.a); const tag = ' [NOT]'
    const lines = A.lines.slice(); lines[A.mid] += tag
    return { lines, mid: A.mid, w: A.w + dw(tag) }
  }
  if (n.t === 'edge') {
    const A = rNode(n.a); const add = `──${n.kind === 'P' ? '┤P├' : '┤N├'}`
    const lines = A.lines.slice(); lines[A.mid] += add
    return { lines, mid: A.mid, w: A.w + dw(add) }
  }
  if (n.t === 'and') {
    const A = rNode(n.a), B = rNode(n.b)
    const mid = Math.max(A.mid, B.mid)
    const offA = mid - A.mid, offB = mid - B.mid
    const h = Math.max(A.lines.length + offA, B.lines.length + offB)
    const lines = []
    for (let i = 0; i < h; i++) {
      const ia = i - offA, ib = i - offB
      const la = ia >= 0 && ia < A.lines.length ? A.lines[ia] : ' '.repeat(A.w)
      const lb = ib >= 0 && ib < B.lines.length ? B.lines[ib] : ' '.repeat(B.w)
      lines.push(la + (i === mid ? '──' : '  ') + lb)
    }
    return { lines, mid, w: A.w + 2 + B.w }
  }
  if (n.t === 'or') {
    const kids = (n.kids ?? []).map(rNode)
    const w = Math.max(0, ...kids.map((k) => k.w))
    const rows = []
    const outRows = []
    const branchRows = []
    for (const k of kids) for (let i = 0; i < k.lines.length; i++) branchRows.push(k.lines[i])
    const jAt = Math.floor(branchRows.length / 2)
    branchRows.forEach((text, idx) => {
      outRows.push({ kind: 'branch', text })
      if (idx === jAt - 1 && jAt < branchRows.length) outRows.push({ kind: 'junction' })
    })
    if (!outRows.some((r) => r.kind === 'junction')) outRows.splice(Math.max(1, Math.ceil(outRows.length / 2)), 0, { kind: 'junction' })
    for (const [i, r] of outRows.entries()) {
      const first = i === 0, last = i === outRows.length - 1
      const lc = first ? '┌' : last ? '└' : r.kind === 'junction' ? '┤' : '├'
      const rc = first ? '┐' : last ? '┘' : r.kind === 'junction' ? '├' : '┤'
      if (r.kind === 'junction') rows.push(lc + ' '.repeat(w + 2) + rc)
      else rows.push(lc + '─' + r.text + ' '.repeat(Math.max(0, w - dw(r.text))) + '─' + rc)
    }
    const mid = outRows.findIndex((r) => r.kind === 'junction')
    return { lines: rows, mid: mid < 0 ? Math.floor(rows.length / 2) : mid, w: w + 4 }
  }
  return { lines: ['?'], mid: 0, w: 1 }
}

// ───────────────────────── 画：输出（线圈 / 指令盒） ─────────────────────────

const MIN_VAL_W = 8
const HAS_ENO = /^(MOV_|INC_|DEC_|SHL_|SHR_|WAND_|WOR_|WXOR_|B_I|I_B|I_DI|DI_I|[+\-*/][IDRBW])/
const INST_BOX = /^(TON|TOF|TONR|CTU|CTD|CTUD)$/

/** 指令盒：左引脚、右引脚（有则画在下边一行）；值写在导线上；EN 行留给进入的导线 */
function boxNode(out) {
  let rows, name
  if (out.kind === 'call') {
    name = out.name
    rows = [{ pinL: 'EN', pinR: '', val: null }, ...out.args.map((a, i) => ({ pinL: `P${i + 1}`, pinR: '', val: a }))]
  } else if (INST_BOX.test(out.m)) {                        // 定时器/计数器：编号进盒名，不算引脚
    name = `${out.m} ${out.ops[0] ?? ''}`
    rows = [
      { pinL: out.m.startsWith('CT') ? 'CU' : 'IN', pinR: '', val: null },
      { pinL: out.m.startsWith('CT') ? 'PV' : 'PT', pinR: '', val: out.ops[1] ?? null },
    ]
  } else {
    name = out.m
    const pins = BOX_PINS[out.m] ?? out.ops.map((_, i) => (RIGHT_PIN.test(out.m) && i === out.ops.length - 1 ? 'OUT' : `IN${i + 1}`))
    const rightOn = RIGHT_PIN.test(out.m) && pins.length >= 2
    rows = [{ pinL: 'EN', pinR: HAS_ENO.test(out.m) ? 'ENO' : '', val: null }]
    pins.forEach((p, i) => {
      if (rightOn && i === pins.length - 1) rows.push({ pinL: '', pinR: p, val: null, valRight: out.ops[i] ?? null })
      else rows.push({ pinL: p, pinR: '', val: out.ops[i] ?? null })
    })
  }
  const vw = Math.max(MIN_VAL_W, ...rows.filter((r) => !r.valRight).map((r) => dw(r.val ?? '')))
  const inside = Math.max(18, ...rows.map((r) => 2 + dw(r.pinL) + dw(r.pinR)))
  const mkLine = (row) => {
    const leftArea = row.valRight ? ' '.repeat(vw) : (row.val ? String(row.val).padEnd(vw) : '─'.repeat(vw))
    const l = row.pinL ? ' ' + row.pinL : ''
    const r = row.pinR ? row.pinR + ' ' : ''
    const inner = l + ' '.repeat(Math.max(1, inside - dw(l) - dw(r))) + r
    return leftArea + '──────│' + inner + '│' + (row.valRight ? '── ' + row.valRight : '')
  }
  const lines = [' '.repeat(vw + 6) + '┌' + '─'.repeat(inside) + '┐', mkLine(rows[0])]
  const midRow = 1
  lines.push(' '.repeat(vw + 6) + '│' + (' ' + name).padEnd(inside) + '│')
  for (const r of rows.slice(1)) lines.push(mkLine(r))
  lines.push(' '.repeat(vw + 6) + '└' + '─'.repeat(inside) + '┘')
  return { lines, mid: midRow, w: dw(lines[1]) }
}

function outNode(out) {
  if (!out) return { lines: [''], mid: 0, w: 0 }
  if (out.kind === 'coil') { const s = `──( ${out.addr} )`; return { lines: [s], mid: 0, w: dw(s) } }
  if (out.kind === 'set' || out.kind === 'reset') {
    const s = `──( ${out.kind === 'set' ? 'S' : 'R'} ${out.addr}${out.n ? ', ' + out.n : ''} )`
    return { lines: [s], mid: 0, w: dw(s) }
  }
  return boxNode(out)
}

// ───────────────────────── 讲解（机械） ─────────────────────────

function describeLogic(n) {
  if (!n) return ''
  if (n.t === 'contact') {
    if (n.cmpOp) {
      const w = { '==': '等于', '<>': '不等于', '>': '大于', '<': '小于', '>=': '不小于', '<=': '不大于' }[n.cmpOp] ?? n.cmpOp
      return `${n.label} ${w} ${n.cmpTo}`
    }
    return `${n.label}${n.sym.includes('/') ? ' 断开' : ' 接通'}`
  }
  if (n.t === 'not') return `非（${describeLogic(n.a)}）`
  if (n.t === 'edge') return `${describeLogic(n.a)}，取${n.kind === 'P' ? '上升' : '下降'}沿`
  if (n.t === 'and') return `${describeLogic(n.a)} 且 ${describeLogic(n.b)}`
  if (n.t === 'or') return `（${(n.kids ?? []).map((k) => (k?.t === 'and' || k?.t === 'or' ? `（${describeLogic(k)}）` : describeLogic(k))).join(' 或 ')}）`
  return '?'
}

function describeOut(out) {
  if (!out) return '（无输出）'
  if (out.kind === 'coil') return `输出 ${out.addr} 得电`
  if (out.kind === 'set') return `置位 ${out.addr}${out.n ? `（含 ${out.n} 位）` : ''}`
  if (out.kind === 'reset') return `复位 ${out.addr}${out.n ? `（含 ${out.n} 位）` : ''}`
  if (out.kind === 'call') return `调用 ${out.name}${out.args.length ? `（参数 ${out.args.join('、')}）` : ''}`
  const v = out.ops ?? []
  if (/^MOV_(B|W|DW|R)$/.test(out.m)) return `把 ${v[0] ?? '?'} 送进 ${v[1] ?? '?'}`
  if (/^(TON|TOF|TONR)$/.test(out.m)) return `${v[0] ?? '?'} 计时，PT=${v[1] ?? '?'}`
  if (/^(CTU|CTD|CTUD)$/.test(out.m)) return `${v[0] ?? '?'} 计数，PV=${v[1] ?? '?'}`
  if (/^(INC|DEC)_/.test(out.m)) return `${v[0] ?? '?'} ${out.m.startsWith('INC') ? '加 1' : '减 1'}${v[1] ? ` → ${v[1]}` : ''}`
  return `${out.m} ${v.join(', ')}（未识别写法，按盒原样画）`
}

export function explainRung(rung) {
  const cond = describeLogic(rung.logic)
  return cond ? `当 ${cond} 时，${describeOut(rung.out)}。` : `${describeOut(rung.out)}。`
}

// ───────────────────────── 总入口 ─────────────────────────

function ladderLines(rung) {
  const L = rNode(rung.logic), O = outNode(rung.out)
  const mid = Math.max(L.mid, O.mid)
  const h = Math.max(L.lines.length + (mid - L.mid), O.lines.length + (mid - O.mid))
  const out = []
  for (let i = 0; i < h; i++) {
    const ia = i - (mid - L.mid), ib = i - (mid - O.mid)
    const la = ia >= 0 && ia < L.lines.length ? L.lines[ia] : ' '.repeat(L.w)
    const lb = ib >= 0 && ib < O.lines.length ? O.lines[ib] : ' '.repeat(O.w)
    out.push('   ' + la + (i === mid ? '──' : '  ') + lb)
  }
  return out
}

/** 语句表 → 文字梯形图（+ 机械讲解）。opts.summary === false 时不出讲解行。 */
export function stlToLadder(text, opts = {}) {
  const nets = parseStl(text)
  const chunks = []
  if (opts.title) chunks.push(opts.title)
  for (const net of nets) {
    const body = [`网络 ${net.no}${net.title ? ' ── ' + net.title : ''}`]
    for (const c of net.comments) body.push(`   // ${c}`)
    const rungs = buildRungs(net)
    if (!rungs.length) { body.push('   （该网络没有可识别的输出指令）'); chunks.push(body.join('\n')); continue }
    for (const rung of rungs) {
      body.push(...ladderLines(rung).map((l) => l.replace(/\s+$/, '')))
      if (opts.summary !== false) body.push(`   讲解：${explainRung(rung)}`)
    }
    chunks.push(body.join('\n'))
  }
  return chunks.join('\n\n') + '\n'
}
