#!/usr/bin/env node
/**
 * hmismart-decode.mjs —— 西门子 WinCC flexible SMART 触摸屏工程（.hmismart）解码器
 *
 * 用法： node hmismart-decode.mjs <工程文件.hmismart> [输出目录]
 * 输出（默认写到 工程文件同级 导出_hmismart_<时间戳>\）：
 *   00-格式说明.md      容器结构、魔数、页结构、编码约定
 *   01-对象记录.tsv     偏移 / 类型GUID / 名称（全量，供查证）
 *   02-对象分类.md      按类型GUID分组的对象清单（画面/变量/元件/图片…）
 *   03-建表脚本.sql     文件内嵌的数据库 DDL（136 张表）
 *   04-解压块.txt       全部 deflate 块解压内容（含属性包、连接配置）
 *   05-系统消息_中文.txt  解压块里的多语言系统文本（中文）
 *   06-可读文本.txt      文件正文里的 UTF-16 文本（去掉结构噪声）
 *   07-统计.json
 * 只读：不修改任何原始文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const args = process.argv.slice(2)
if (!args[0]) { console.error('用法: node hmismart-decode.mjs <工程文件.hmismart> [输出目录]'); process.exit(1) }
const src = path.resolve(args[0])
if (!fs.existsSync(src)) { console.error('文件不存在: ' + src); process.exit(1) }
// 默认输出：当前工作目录下的「解码归档\<工程名>\HMI解码\」，不写工程目录、不写临时目录
const projectName = path.basename(src, path.extname(src))
const outDir = path.resolve(args[1] || path.join(process.cwd(), '解码归档', projectName, 'HMI解码'))
fs.mkdirSync(outDir, { recursive: true })

const buf = fs.readFileSync(src)
const stat = { file: src, size: buf.length, outputs: {} }
const w = (name, content) => { fs.writeFileSync(path.join(outDir, name), content); stat.outputs[name] = Buffer.byteLength(content) }

/* ---------- 1. 容器头 ---------- */
const magic = [...buf.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' ')
const header = {
  magic,
  size: buf.length,
  pages4k: buf.length / 4096,
  pageAligned: buf.length % 4096 === 0,
}

/* ---------- 2. DDL（数据库 schema） ---------- */
const asciiStrings = []
{ let cur = '', start = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c >= 32 && c < 127) { if (!cur) start = i; cur += String.fromCharCode(c) }
    else { if (cur.length >= 6) asciiStrings.push([start, cur]); cur = '' }
  } }
const ddl = asciiStrings.filter(([, s]) => /\b(CREATE TABLE|CREATE PROCEDURE|CREATE INDEX|ALTER TABLE|INSERT INTO|SELECT )/i.test(s))
const tables = new Set()
for (const [, s] of asciiStrings) for (const m of s.matchAll(/\b(Hmi[A-Za-z]{2,45}Table)\b/g)) tables.add(m[1])

/* ---------- 3. 解压全部 deflate 块 ---------- */
const blocks = []
for (let i = 0; i + 3 <= buf.length; i++) {
  if (buf[i] === 0x1f && buf[i + 1] === 0x8b && buf[i + 2] === 0x08) {
    try { blocks.push({ off: i, out: zlib.inflateRawSync(buf.subarray(i + 10)) }) } catch { }
    i += 3
  }
}
const uniqBlocks = []
{ const seen = new Set()
  for (const b of blocks) { const k = b.out.length + ':' + b.out.subarray(0, 64).toString('hex'); if (!seen.has(k)) { seen.add(k); uniqBlocks.push(b) } } }

/* ---------- 4. 对象记录：36 + UUIDv4 + 字段 + 名称 ---------- */
const isUuid4 = (o) => {
  if (o + 16 > buf.length) return false
  if ((buf[o + 7] >> 4) !== 4) return false
  if ((buf[o + 8] & 0xc0) !== 0x80) return false
  let z = 0; for (let i = 0; i < 16; i++) if (buf[o + i] === 0) z++
  return z <= 3
}
const guidHex = (o) => [...buf.subarray(o, o + 16)].map(x => x.toString(16).padStart(2, '0')).join('')
const fmtGuid = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
const isNameChar = c => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d || c === 0x2e || c === 0x28 || c === 0x29 || c === 0xff08 || c === 0xff09
function readAt(s, limit = 60) { let j = s, str = '', ascii = 0
  while (j + 1 < buf.length && str.length < limit) { const c = buf[j] | (buf[j + 1] << 8)
    if (isNameChar(c) || c === 0x20) { str += String.fromCharCode(c); if (c < 0x80) ascii++; j += 2 } else break }
  return { str, ascii } }
function readBest(from, back = 28) { let best = null
  for (let s = from; s < from + back; s++) { const r = readAt(s)
    if (r.str.length < 2 || r.str.length > 48) continue
    const cjk = /[\u4e00-\u9fff]/.test(r.str)
    const score = r.str.length + (cjk ? 6 : 0) + (r.ascii / r.str.length) * 4
    if (!best || score > best.score) best = { off: s, ...r, score } }
  return best }
const clean = s => s.replace(/^[^\u4e00-\u9fffA-Za-z0-9]+/, '').replace(/[\s]+$/, '').trim()

const rawRecs = []
for (let i = 0; i + 17 <= buf.length; i++) {
  if (buf[i] !== 0x36 || !isUuid4(i + 1)) continue
  const nm = readBest(i + 17)
  if (!nm) continue
  const name = clean(nm.str)
  if (name.length < 2) continue
  rawRecs.push({ off: i, g: guidHex(i + 1), name, cjk: /[\u4e00-\u9fff]/.test(name) })
}
const guidCount = new Map()
for (const r of rawRecs) guidCount.set(r.g, (guidCount.get(r.g) || 0) + 1)

// 去噪两道：① 真类型 GUID 会被反复引用；② 真对象名里的汉字会在多个名字里复现，
// 二进制误读出的"生僻字"通常只此一次（用字符 document-frequency 判定）
const charDF = new Map()
for (const r of rawRecs) for (const ch of new Set(r.name)) charDF.set(ch, (charDF.get(ch) || 0) + 1)
// 名称紧跟记录结构字节，尾部常粘 1~2 个误读出来的字；用常用字集合判边界，只截集合外的尾字。
// 集合已按字符去重平铺（只判成员关系，不构成词）；遇到误截时往集合里补该字即可。
const LEX = '上下业中主书产伺位低体作保值停入关内出切列刻前剔加动单卡压原参双变口右号后启吸吹喷器回图圆堵备复外大头始子字存定寄密封小少尾屏工左差带平年序库废度延开当形志急户手托护报择指挡换据推放故数整文料新旋日旧时更月有服本机杆束标检棒止比气测清点片瓶用画的盒矩短码移程站符箭累纸线组结编缺置联胶自舌色藏蜂表视言警计设试语调转轴输送选速量针锁长间隐障零面顶题飞高鸣'
const trimNoise = (n) => {
  let b = n.length
  while (b > 1) {
    const c = n[b - 1]
    if (LEX.includes(c)) break
    if (/[A-Za-z0-9_\.]/.test(c)) break
    b--
  }
  return n.slice(0, b)
}
const cjkRatioOk = (n) => {
  const cs = [...n].filter(c => c >= '\u4e00' && c <= '\u9fff')
  if (!cs.length) return true
  return cs.filter(c => (charDF.get(c) || 0) >= 5).length / cs.length >= 0.5
}
const hasNoiseChar = (n) => /[\u3400-\u4dbf\uf900-\ufaff\ufffd]/.test(n)
const recs = rawRecs
  .filter(r => guidCount.get(r.g) >= 3 && !hasNoiseChar(r.name) && cjkRatioOk(r.name))
  .map(r => ({ ...r, name: trimNoise(r.name) }))
  .filter(r => r.name.length >= 2)

/* ---------- 5. 多语言系统消息（中文） ---------- */
const zhMsgs = new Set()
for (const b of uniqBlocks) {
  const s = b.out.toString('utf8')
  if (!s.includes('<text>')) continue
  for (const m of s.matchAll(/zh-CN[^<]*<text>([\s\S]{1,200}?)<\/text>/g)) {
    const t = m[1].replace(/<[^>]+>/g, '').trim()
    if (t && t.length <= 120) zhMsgs.add(t)
  }
}

/* ---------- 6. 正文 UTF-16 文本（排除 ASCII 区与压缩数据区） ---------- */
const mask = new Uint8Array(buf.length)
for (let i = 0; i < buf.length - 24; i += 8) {           // ASCII 密集区
  let a = 0; for (let j = 0; j < 24; j++) { const c = buf[i + j]; if (c >= 32 && c < 127) a++ }
  if (a >= 20) for (let j = 0; j < 24; j++) mask[i + j] = 1
}
for (const b of blocks) for (let j = b.off; j < b.off + 24 && j < buf.length; j++) mask[j] = 1  // 压缩块头
const texts = new Set()
for (let i = 0; i + 3 < buf.length; i += 2) {
  if (mask[i]) continue
  const c = buf[i] | (buf[i + 1] << 8)
  if (!((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x41 && c <= 0x7a))) continue
  let j = i, s = ''
  while (j + 1 < buf.length && !mask[j]) { const cc = buf[j] | (buf[j + 1] << 8)
    if (isNameChar(cc) || cc === 0x20) { s += String.fromCharCode(cc); j += 2 } else break }
  if (s.length >= 3 && /[\u4e00-\u9fff]/.test(s)) { const t = clean(s); if (t.length >= 2) texts.add(t) }
  i = Math.max(i, j - 2)
}

/* ---------- 7. 分类 ---------- */
// 已确证的类型 GUID（靠"该类型下全部名称的语义"交叉验证得出，可继续扩充）
const KNOWN_TYPES = {
  a8d0ec5ba448dd4e8cfd1f93bab80357: '画面',
  '98441ece8aaa384190250908339aa88e': '变量（HMI 变量表）',
  '2eee2253373c9e4fb5b9bd3a205f6713': '对象类型目录（元件类型名）',
  '87c833306870a9498ae24da1919746b3': '画面元件（IO域/文本域/开关）',
  '50ed3daea5a013448ae19ed8f4043d9c': '画面元件（按钮/文本域）',
  e95e1fa2f2f8b946b47532cc5399bd9f: '画面元件（按钮/线）',
  '7cc6b8efde529f4aab60be9937564c5f': '画面元件（矩形/按钮/开关/图形）',
  a75c8f057bd20e45b5ca070891443d1d: '画面元件（IO域/开关/文本域）',
  d6ae66afa96fb3408df18d44f2585873: '画面元件（IO域/开关/文本域/报警视图）',
  a1b2d38181484d489401867b9fdcc709: '模板元件（模板按钮/IO域/开关）',
  d65b6511ea528442af7579c84c001e54: '图片资源',
  '0c0a9fede4f16d438fed097fa8051506': '通讯连接',
  '35b3711327ef66408b82c3097100029e': 'Smart 主题/样式（软件自带）',
  '11fea9ca9da43d4289fe389107a3e925': '字体列表',
  '49a4d64cb82e814292102c7fd2007115': '系统函数',
  d0aeebe5b8663d478fb6b5f4ac6c9d96: '项目结构节点',
  '3848614b96efc141bcd4124814bbf961': '项目结构节点',
  b0e0cad9a3bb074da9cf296d0573e254: '项目树节点',
  cc1746b51be8f74b8cef934dd946b81b: '系统变量（画面号/时间等）',
  e2a88f13a660734fbe15ec7df20c04a8: '用户与权限',
  ad962e667c6b5c4887ae1d834a4205b8: '报警确认组',
  d912bd6b8243fd4384aa4d3bfa5650ef: '用户/授权',
  fa8ef5c6e7da2d4b984bb1e109cf948b: '采集周期',
  '3957818870145243b9e0a928e3f16129': '图形列表',
  c67c51d88bbb4c49840423ac3926928e: '报警类别/事件',
  '00a28e5290ccc64f937a905f6222ffea': '数据类型与消息文件夹',
  '02c4e0f59ad3c34d9d6baaf4fb8a6bf6': '数据类型与文本文件夹',
  '7a065037c383944f9bbf977931038c84': '用户/授权管理',
  '912c1ca9472b964e891aa54b3f27a71f': '图库条目',
  '658b5e3163262b47bc8f4c14c316f7eb': '报警消息文件夹',
}
const PATTERNS = [
  ['画面', /画面/],
  ['画面元件', /^(按钮|文本域|IO 域|开关|矩形|线|圆|图形|报警视图|日期时间域|符号|笑脸|棒图|指针|刻度)/],
  ['模板元件', /^模板/],
  ['变量', /(报警|速度|计数|清零|用户名|用户密码|当前[日年月]|^[QIMVDB]\d)/],
  ['图片/图形资源', /(截图|图片|照片|GRAPHIC|箭头|起始位置)/],
  ['通讯/连接', /(连接|Communication|S7ONLINE|TCPIP|ETHERNET)/],
  ['报警/用户/配方', /(确认组|报警组|报警类别|配方|激活码|权限|管理员|操作员)/],
  ['系统函数', /^(ActivateScreen|GetPassword|GetUserName|InvertBit|Logoff|Logon|SetBit|SetValue|IncreaseValue|StartDataTransfer|ChangeConnection|SetLanguage|AddressCulture)/],
  ['数据类型', /(Internal$|SIMATIC S7)/],
  ['项目结构/系统对象', /(Folder|Settings|Reports|Messages|Library|Modules|Functions|Global|Prototype|Documentation|CrossReference|Devices|Images|Lists|Containers)/],
  ['样式/主题', /^Smart-/],
  ['时间/周期', /^\d+ ?(ms|s|min|h)$/],
]
function classify(g) {
  if (KNOWN_TYPES[g]) return KNOWN_TYPES[g]
  const names = [...new Set(recs.filter(r => r.g === g).map(r => r.name))]
  if (!names.length) return '其他'
  // 疑似噪声区：中文名极少且名字短碎，判为二进制误命中
  const cjkNames = names.filter(n => /[\u4e00-\u9fff]/.test(n)).length
  if (cjkNames / names.length < 0.15 && names.length >= 8) return '疑似二进制区（非对象）'
  let best = null
  for (const [label, re] of PATTERNS) {
    const hit = names.filter(n => re.test(n)).length / names.length
    if (hit >= 0.5 && (!best || hit > best.hit)) best = { label, hit }
  }
  return best ? best.label : '其他/待定'
}

/* ---------- 7b. 结构化表（压缩块里的 XML 表；2026-11-06 新增） ---------- */
// 新版 .hmismart 的压缩块里是 XML 表（HmiScreenTable / HmiScreenItemTable / HmiTextTable / HmiDeviceTable）。
// 解出来的表比整份 dump 小一个数量级，按问题查表即可，不必读 dump。
function buildStructTables(blockTexts) {
  const grab = (body, tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body); return m ? m[1] : '' }
  // 只在单个压缩块内匹配完整记录：跨块拼接会把「开始标签在前一块、结束标签在后一块」的
  // 残片吞进来（body 里混进别的表，取到错名字）。块内切不完整的记录直接丢弃。
  const rows = (tag) => {
    const out = []
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
    for (const t of blockTexts) for (const m of t.matchAll(re)) out.push(m[1])
    return out
  }
  const screens = rows('HmiScreenTable').map(b => ({
    id: grab(b, 'ObjId'), name: grab(b, 'ObjName'), number: grab(b, 'Number'),
    deleted: grab(b, 'Deleted'), device: grab(b, 'DeviceNumber'), mtime: grab(b, 'LastModified'),
  })).filter(r => r.name)
  const byId = new Map(screens.map(r => [r.id, r]))
  const items = rows('HmiScreenItemTable').map(b => ({
    id: grab(b, 'ObjId'), name: grab(b, 'ObjName'), type: grab(b, 'HmiSubType'),
    screenId: grab(b, 'ParentId'), x: grab(b, 'LocationX'), y: grab(b, 'LocationY'),
    w: grab(b, 'SizeX'), h: grab(b, 'SizeY'), mtime: grab(b, 'LastModified'),
  })).filter(r => r.name)
  const itemById = new Map(items.map(r => [r.id, r]))
  const texts = rows('HmiTextTable').map(b => ({
    ownerId: grab(b, 'ContainerId'), type: grab(b, 'TextType'),
    sys: grab(b, 'IsSystemMessageText'), text: grab(b, 'Language0'), mtime: grab(b, 'LastModified'),
  })).filter(r => r.text)
  const devices = rows('HmiDeviceTable').map(b => ({
    name: grab(b, 'ObjName'), model: grab(b, 'DeviceType'), startId: grab(b, 'StartScreenId'),
    w: grab(b, 'ScreenSizeWidth'), h: grab(b, 'ScreenSizeHeight'), mtime: grab(b, 'LastModified'),
  })).filter(r => r.name)
  // 类型密码本：TypeCode ↔ 类型全名（.data 里判断对象/引用类型用）
  const types = rows('HmiTypeTable').map(b => ({
    code: grab(b, 'TypeCode'), name: grab(b, 'TypeName'), id: grab(b, 'TypeId'),
  })).filter(r => r.name && r.code)
  // 同一对象在多个压缩块里出现（工程内多版本快照），按主键取 LastModified 最新的一条
  const dedupe = (arr, keyFn) => {
    const m = new Map()
    for (const r of arr) {
      const k = keyFn(r), cur = m.get(k)
      if (!cur || String(r.mtime || '') >= String(cur.mtime || '')) m.set(k, r)
    }
    return [...m.values()]
  }
  return {
    screens: dedupe(screens, r => r.id || r.name),
    items: dedupe(items, r => r.id || r.name),
    texts: dedupe(texts, r => `${r.ownerId}|${r.type}|${r.text}`),
    devices: dedupe(devices, r => `${r.name}|${r.model}`),
    types: dedupe(types, r => r.code),
    byId, itemById,
  }
}
const struct = buildStructTables(blocks.map(b => b.out.toString('utf8')))

/* ---------- 7c. 旁系 .data（ES2RT 序列化）：真实变量/控件名 ---------- */
// .hmismart 里只有模板骨架；真实画面/控件/变量在 <工程名>_{{GUID}}.data：
// 'ES2RT' 头 + gzip → 解出 18MB 的 .NET 序列化对象流，UTF-8 字符串可读。
// 目前能可靠抽出三族名字；控件→变量的绑定引用未解出（标在报告里）。
function extractDataNames(file) {
  try {
    const d = fs.readFileSync(file)
    const gi = d.indexOf(Buffer.from([0x1f, 0x8b, 0x08]))
    if (gi < 0) return null
    const raw = zlib.inflateRawSync(d.subarray(gi + 10))
    const text = new TextDecoder('utf-8', { fatal: false }).decode(raw)
    const BAD = /hmiType|objName|esHandle|lang2Text|missingText|TextList|messageParameters|isProjectedText|System\.|Siemens\.|ES2RT|k__BackingField|Dependencies|CustomMaxTextLength|theCauseHandle|idParent/
    const isName = (s) => {
      if (s.length < 2 || s.length > 24) return false
      if (BAD.test(s)) return false
      if (/[\u4e00-\u9fff]/.test(s)) return true
      if (/^[QIMVWDB]\d{1,5}(\.\d)?$/i.test(s)) return true
      return false
    }
    const pick = (seg) => {
      const runs = [...seg.matchAll(/[\u4e00-\u9fffA-Za-z0-9 _.\-]{2,24}/g)].map(m => m[0].trim()).filter(isName)
      return runs.length ? runs[runs.length - 1] : ''
    }
    const collect = (tn) => {
      const names = []
      let p = -1
      while ((p = text.indexOf(tn, p + 1)) >= 0) {
        const n = pick(text.slice(Math.max(0, p - 600), p))
        if (n) names.push(n)
      }
      return [...new Set(names)]
    }
    // 控件→变量：按 ES2RT 段切分（相邻真头之间为一段），控件段内出现变量名（词边界）即绑定候选
    const heads = []
    for (let i = 0; i + 12 < raw.length; i++) {
      if (raw[i] === 0x45 && raw[i + 1] === 0x53 && raw[i + 2] === 0x32 && raw[i + 3] === 0x52 && raw[i + 4] === 0x54 && raw[i + 5] === 0x01) heads.push(i)
    }
    const segText = (k) => new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(heads[k], k + 1 < heads.length ? heads[k + 1] : raw.length))
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hasWord = (t, w) => new RegExp(`(^|[^\\u4e00-\\u9fffA-Za-z0-9_])${esc(w)}([^\\u4e00-\\u9fffA-Za-z0-9_]|$)`).test(t)
    const tagList = [...new Set(collect('Siemens.Simatic.Hmi.Utah.Tag.HmiTag'))]
    const isUuid4 = (b, o) => o + 16 <= b.length && (b[o + 7] >> 4) === 4 && (b[o + 8] & 0xc0) === 0x80
    const uuidsOf = (b) => { const o = []; for (let i = 0; i + 16 <= b.length; i++) if (isUuid4(b, i)) o.push(b.subarray(i, i + 16).toString('hex')); return o }
    const segBuf = (k) => raw.subarray(heads[k], k + 1 < heads.length ? heads[k + 1] : raw.length)
    // 变量对象 id：每段结构固定，对象 id 在段内偏移 0x19（16 字节）
    const segId = (b) => b.length > 0x29 ? b.subarray(0x19, 0x29).toString('hex') : ''
    const tagByUuid = new Map()
    for (let k = 0; k < heads.length; k++) {
      const t = segText(k)
      if (!t.includes('Siemens.Simatic.Hmi.Utah.Tag.HmiTag')) continue
      const n = pick(t), id = segId(segBuf(k))
      if (n && id && !tagByUuid.has(id)) tagByUuid.set(id, n)
    }
    const bindings = []
    const seen = new Set()
    const pushB = (item, tag, by) => { const k = item + '\u0001' + tag; if (!seen.has(k)) { seen.add(k); bindings.push({ item, tag, by }) } }
    for (let k = 0; k < heads.length; k++) {
      const t = segText(k)
      if (!t.includes('Siemens.Simatic.Hmi.Utah.GraphX.HmiScreenItem')) continue
      const name = pick(t)
      if (!name) continue
      for (const w of tagList) if (w !== name && hasWord(t, w)) pushB(name, w, '同段共现')
      const b2 = segBuf(k)
      for (const u of new Set(uuidsOf(b2))) {
        const w = tagByUuid.get(u)
        if (w && w !== name) pushB(name, w, 'UUID 引用')
      }
    }
    return {
      file: path.basename(file),
      bytes: d.length,
      inflated: raw.length,
      segments: heads.length,
      screens: collect('Siemens.Simatic.Hmi.Utah.GraphX.HmiScreen'),
      items: collect('Siemens.Simatic.Hmi.Utah.GraphX.HmiScreenItem'),
      tags: collect('Siemens.Simatic.Hmi.Utah.Tag.HmiTag'),
      bindings,
    }
  } catch { return null }
}
let dataNames = null
try {
  const dir = path.dirname(src)
  const cand = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.data'))
  if (cand.length) {
    // 取最大的那个：同目录常有两个 .data，小的那个只存键值不入对象
    let best = cand[0], bestSize = -1
    for (const f of cand) {
      try { const sz = fs.statSync(path.join(dir, f)).size; if (sz > bestSize) { best = f; bestSize = sz } } catch { }
    }
    dataNames = extractDataNames(path.join(dir, best))
  }
} catch { }

/* ---------- 输出 ---------- */
const report = []
report.push(`# .hmismart 解码报告`, '', `- 源文件：${src}`, `- 文件大小：${buf.length} 字节（${(buf.length / 1048576).toFixed(2)} MB）`, `- 文件头魔数：\`${magic}\``, `- 页结构：${header.pageAligned ? `页对齐，4096 × ${header.pages4k} 页` : '非 4096 对齐'}`, `- 压缩块：${blocks.length} 个（去重 ${uniqBlocks.length}），解压总量 ${(blocks.reduce((a, b) => a + b.out.length, 0) / 1048576).toFixed(2)} MB`, `- 内嵌数据表：${tables.size} 张`, `- 对象记录：${rawRecs.length} 条（有效类型 ${guidCount.size} 种，过滤后 ${recs.length} 条）`, `- 中文系统消息：${zhMsgs.size} 条`, `- 正文可读文本：${texts.size} 条`, '')
report.push(`- 结构化表：画面 ${struct.screens.length} / 元件 ${struct.items.length} / 文本 ${struct.texts.length} / 设备 ${struct.devices.length}（来自 .hmismart 内嵌 XML 表；0 表示本格式无 XML 表，见 01/01b/02。真实画面/控件与绑定变量在旁系 {{GUID}}.data 与 .srt，不在这张表里）`)
if (dataNames) report.push(`- 旁系 .data：${dataNames.file}（${(dataNames.bytes / 1048576).toFixed(1)} MB → 解压 ${(dataNames.inflated / 1048576).toFixed(1)} MB / ${dataNames.segments} 段）｜变量名 ${dataNames.tags.length} / 控件名 ${dataNames.items.length} / 画面候选 ${dataNames.screens.length} / 绑定候选 ${dataNames.bindings.length}（见 20/21/22/23）`)
else report.push('- 旁系 .data：未找到（同目录无 {{GUID}}.data）')
w('00-格式说明.md', report.join('\n'))

w('01-对象记录.tsv', '偏移\t类型GUID\t名称\n' + rawRecs.map(r => `0x${r.off.toString(16)}\t${fmtGuid(r.g)}\t${r.name}`).join('\n'))
w('01b-对象记录-清洗.tsv', '偏移\t类型GUID\t名称\n' + recs.map(r => `0x${r.off.toString(16)}\t${fmtGuid(r.g)}\t${r.name}`).join('\n'))

const groups = [...guidCount.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
const cat = new Map()
for (const [g] of groups) { const k = classify(g); if (!cat.has(k)) cat.set(k, []); cat.get(k).push(g) }
const catLines = ['# 对象分类清单', '', '每行 = 类型GUID｜记录数｜该类型下的全部唯一名称（去重）。', '']
for (const [k, gs] of [...cat.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const total = gs.reduce((a, g) => a + guidCount.get(g), 0)
  catLines.push(`## ${k}（${gs.length} 类 / ${total} 条）`, '')
  for (const g of gs) {
    const names = [...new Set(recs.filter(r => r.g === g).map(r => r.name))]
    catLines.push(`- \`${fmtGuid(g)}\` ×${guidCount.get(g)}｜唯一 ${names.length}`)
    catLines.push('  ' + names.join('、'))
  }
  catLines.push('')
}
w('02-对象分类.md', catLines.join('\n'))

w('03-建表脚本.sql', ddl.map(([o, s]) => `-- 0x${o.toString(16)}\n${s}`).join('\n\n'))

// 解压块分两堆：工程数据（属性包/对象数据）与软件自带的多语言系统文本
const isMultiLang = (s) => /<text>/.test(s) && /hu-HU|cs-CZ|ja-JP|zh-TW|de-DE|en-US|fr-FR|es-ES|it-IT|pt-PT|ru-RU|ko-KR/.test(s)
const propBlocks = [], langBlocks = []
for (const b of uniqBlocks) (isMultiLang(b.out.toString('utf8')) ? langBlocks : propBlocks).push(b)
const dumpBlock = (b, k) => `\n===BLK#${k} @0x${b.off.toString(16)} len=${b.out.length}===\n` + b.out.toString('utf8').replace(/[^\x09\x0a\x20-\x7e\u4e00-\u9fff]/g, '·')
w('04-解压块-工程数据.txt', propBlocks.map(dumpBlock).join('\n'))
w('05-解压块-多语言文本.txt', langBlocks.map(dumpBlock).join('\n'))

fs.writeFileSync(path.join(outDir, '06-系统消息_中文.txt'), [...zhMsgs].sort().join('\n'))
stat.outputs['06-系统消息_中文.txt'] = fs.statSync(path.join(outDir, '06-系统消息_中文.txt')).size

fs.writeFileSync(path.join(outDir, '07-可读文本.txt'), [...texts].sort().join('\n'))
stat.outputs['07-可读文本.txt'] = fs.statSync(path.join(outDir, '07-可读文本.txt')).size

/* 结构化表落盘：一份问题一张表，AI 按问题只读对应那份 */
const tsv = (head, lines) => head + '\n' + lines.join('\n') + (lines.length ? '\n' : '')
const ownerOf = id => (struct.itemById.get(id) || struct.byId.get(id) || { name: String(id).slice(0, 8) }).name
if (struct.screens.length) {
  w('10-画面.tsv', tsv('画面名\t编号\t已删除\t设备号\tObjId', struct.screens.map(r => `${r.name}\t${r.number}\t${r.deleted}\t${r.device}\t${r.id}`)))
}
if (struct.items.length) {
  w('11-元件.tsv', tsv('画面\t元件名\t类型\tX\tY\t宽\t高\tObjId', struct.items.map(r => `${(struct.byId.get(r.screenId) || {}).name || ''}\t${r.name}\t${r.type}\t${r.x}\t${r.y}\t${r.w}\t${r.h}\t${r.id}`)))
}
if (struct.texts.length) {
  w('12-文本.tsv', tsv('所属\t文本类型\t系统消息\t文本', struct.texts.map(r => `${ownerOf(r.ownerId)}\t${r.type}\t${r.sys}\t${r.text.replace(/\t/g, ' ')}`)))
}
if (struct.devices.length) {
  w('13-设备.tsv', tsv('设备名\t型号\t起始画面ID\t起始画面\t分辨率', struct.devices.map(r => {
    const s = struct.byId.get(r.startId)
    return `${r.name}\t${r.model}\t${r.startId}\t${s ? s.name : '(不在画面表)'}\t${r.w}×${r.h}`
  })))
}
if (struct.types.length) {
  w('24-类型表.tsv', tsv('TypeCode\t类型全名', struct.types.map(r => `${r.code}\t${r.name}`)))
}

/* 旁系 .data 名字清单：真实变量/控件在这里，.hmismart 里只有模板骨架 */
if (dataNames) {
  w('20-变量.data.tsv', '变量名\n' + dataNames.tags.join('\n') + (dataNames.tags.length ? '\n' : ''))
  w('21-控件.data.tsv', '控件名\n' + dataNames.items.join('\n') + (dataNames.items.length ? '\n' : ''))
  w('22-画面候选.data.txt', '# 画面候选（ES2RT 邻近名，可能混入控件名；未与画面表对齐）\n' + dataNames.screens.join('\n') + '\n')
  if (dataNames.bindings.length) {
    w('23-控件绑定.data.tsv', '控件\t变量\t依据\n' + dataNames.bindings.map(b => `${b.item}\t${b.tag}\t${b.by}`).join('\n') + '\n')
  }
}

w('08-统计.json', JSON.stringify({ ...stat, tables: [...tables].sort(), blocks: blocks.length, uniqBlocks: uniqBlocks.length, propBlocks: propBlocks.length, langBlocks: langBlocks.length, blockBytes: blocks.reduce((a, b) => a + b.out.length, 0), recs: rawRecs.length, recsKept: recs.length, guidTypes: guidCount.size, zhMsgs: zhMsgs.size, texts: texts.size, structRows: { screens: struct.screens.length, items: struct.items.length, texts: struct.texts.length, devices: struct.devices.length }, dataNames: dataNames ? { file: dataNames.file, bytes: dataNames.bytes, inflated: dataNames.inflated, segments: dataNames.segments, tags: dataNames.tags.length, items: dataNames.items.length, screens: dataNames.screens.length, bindings: dataNames.bindings.length } : null }, null, 2))

console.log(`[完成] 输出目录：${outDir}`)
for (const [k, v] of Object.entries(stat.outputs)) console.log(`  ${k}  ${(v / 1024).toFixed(1)} KB`)
console.log(`  内嵌表 ${tables.size} 张｜对象记录 ${rawRecs.length}→${recs.length} 条｜类型 ${guidCount.size} 种｜压缩块 ${blocks.length}（唯一 ${uniqBlocks.length}：工程数据 ${propBlocks.length} / 多语言 ${langBlocks.length}）｜中文系统消息 ${zhMsgs.size}｜可读文本 ${texts.size}`)
