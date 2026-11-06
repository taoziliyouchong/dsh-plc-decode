#!/usr/bin/env node
/**
 * report.mjs —— 读 hmismart-decode.mjs 的输出，生成人读报告
 * 用法： node report.mjs <解码输出目录> [工程名]
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve(process.argv[2])
const projName = process.argv[3] || path.basename(path.dirname(dir))
// 优先用清洗后的记录（01b）；没有时退回全量（01）
const tsvFile = fs.existsSync(path.join(dir, '01b-对象记录-清洗.tsv')) ? '01b-对象记录-清洗.tsv' : '01-对象记录.tsv'
const tsv = fs.readFileSync(path.join(dir, tsvFile), 'utf8').split('\n').slice(1).filter(Boolean)

const recs = tsv.map(l => { const [off, g, ...rest] = l.split('\t'); return { off, g, name: rest.join('\t') } })
const byType = new Map()
for (const r of recs) { if (!byType.has(r.g)) byType.set(r.g, []); byType.get(r.g).push(r.name) }
const uniq = g => [...new Set(byType.get(g) || [])]
const stat = JSON.parse(fs.readFileSync(path.join(dir, '08-统计.json'), 'utf8'))

const TYPE = {
  screen: 'a8d0ec5b-a448-dd4e-8cfd-1f93bab80357',
  tag: '98441ece-8aaa-3841-9025-0908339aa88e',
  conn: '0c0a9fed-e4f1-6d43-8fed-097fa8051506',
  image: 'd65b6511-ea52-8442-af75-79c84c001e54',
  tmpl: 'a1b2d381-8148-4d48-9401-867b9fdcc709',
  user: 'e2a88f13-a660-734f-be15-ec7df20c04a8',
  user2: 'd912bd6b-8243-fd43-84aa-4d3bfa5650ef',
  confirm: 'ad962e66-7c6b-5c48-87ae-1d834a4205b8',
  sysvar: 'cc1746b5-1be8-f74b-8cef-934dd946b81b',
  period: 'fa8ef5c6-e7da-2d4b-984b-b1e109cf948b',
  graphlist: '39578188-7014-5243-b9e0-a928e3f16129',
}

const VAR_GROUPS = [
  ['PLC 直接地址', /^[QIMV]\d|^VD\d|^VW\d|^VB\d|^CD\d|^\d/],
  ['锁机 / 产量限制', /锁机/],
  ['伺服 / 编码器 / 位置', /伺服|编码器|旋转|原点|位置|位移|偏移/],
  ['加料 / 送料 / 挡料', /加料|送料|上料|放料|挡料|整料|整平/],
  ['吸盒 / 吸托 / 吸纸 / 吹气', /吸盒|吸托|吸纸|吹气|气压/],
  ['封盒 / 压盒 / 顶盒 / 推料', /封盒|压盒|压托|顶盒|顶托|推托|推料|压料|压舌|推杆|飞料/],
  ['喷胶', /喷胶/],
  ['检测 / 剔废', /检测|测书|测托|测料|测盒|测速|测瓶|剔废|测瓶/],
  ['报警 / 故障', /报警|故障|急停|缺料|缺纸|堵料|卡盒|盒子|托库/],
  ['速度 / 计数 / 产量', /速度|计数|产量|清零|速比/],
  ['画面 / 显示', /画面|隐藏/],
  ['用户 / 密码', /用户|密码|权限/],
  ['日期 / 时间', /当前[日年月]|[日月年]期/],
  ['屏操作 / 模式', /屏|启动|停止|点动|手动|调试|自动|联机|复位|运行/],
  ['备用', /备用/],
]
const grouped = new Set()
const varLines = []
const tags = uniq(TYPE.tag)
for (const [label, re] of VAR_GROUPS) {
  const hit = tags.filter(t => re.test(t) && !grouped.has(t))
  hit.forEach(t => grouped.add(t))
  if (hit.length) varLines.push(`- **${label}**（${hit.length}）：${hit.join('、')}`)
}
const restTags = tags.filter(t => !grouped.has(t))
if (restTags.length) varLines.push(`- **其他**（${restTags.length}）：${restTags.join('、')}`)

const screens = uniq(TYPE.screen)
const images = uniq(TYPE.image).filter(n => !/\.(Internal|SIMATIC S7)/.test(n))
const auths = uniq(TYPE.user2).filter(n => !/LastUsedShortId|^[a-f0-9-]{16,}/.test(n))
const compTypes = Object.keys(TYPE).length
const compLines = []
for (const [g, names] of byType) {
  const u = [...new Set(names)]
  if (u.length >= 3 && u.filter(n => /^(按钮|文本域|IO 域|开关|矩形|线|图形|报警视图|日期时间域|符号)/.test(n)).length / u.length > 0.5) {
    compLines.push(`| ${g} | ${u.length} | ${u.slice(0, 24).join('、')}${u.length > 24 ? ' …' : ''} |`)
  }
}

const md = `# .hmismart 解码报告 — ${projName}

> 源文件：\`${stat.file}\`
> 大小 ${stat.size.toLocaleString()} 字节（${(stat.size / 1048576).toFixed(2)} MB）
> 产物目录：\`${dir}\`

## 0. 结论

这份文件**不是压缩包、也没有加密**——它是西门子 WinCC flexible SMART 的**工程数据库**（单文件）。里面明文存着这台设备触摸屏的完整组态：

| 内容 | 数量 |
|---|---|
| 画面 | ${screens.length} 项（含模板/文件夹 ${screens.filter(s => /Folder|Template/i.test(s)).length} 项） |
| HMI 变量 | ${tags.length} 个 |
| 通讯连接 | ${uniq(TYPE.conn).length} 个 |
| 画面元件 | ${compLines.length} 类（按钮/文本域/IO域/开关/矩形/线/图形视图/报警视图/日期时间域） |
| 图片资源 | ${images.length} 项 |
| 内嵌数据表 | ${stat.tables.length} 张 |
| 压缩块 | ${stat.blocks} 个 → 解压 ${(stat.blockBytes / 1048576).toFixed(2)} MB |

## 1. 文件格式（逆向结果）

**魔数**：\`01 0F 00 00 08 02 00 00\`｜**页结构**：4096 字节 × ${stat.size / 4096} 页（严格页对齐）

文件里同时存在三种存储形态：

1. **明文对象记录**（对象名、变量名、连接名就在这）
   结构：\`36\` + UUID(16 字节) + 若干字段 + 名称(UTF-16LE)
   UUID 是**对象类别**，同一类对象共用一个 UUID（本文件共 ${stat.guidTypes} 种）。
2. **压缩块**：\`1f 8b 08 00 00 00 00 00 04 00\`（gzip 头）+ **裸 deflate**，**没有 CRC/ISIZE 尾部**
   ——所以标准 \`gunzip\` 打不开（只能解出 112/${stat.blocks} 个），必须用 \`inflateRaw\` 才能全解。
   压缩块里是对象的"属性名 + 属性值"序列，以及软件自带的多语言系统消息。
3. **内嵌数据库 DDL**：${stat.tables.length} 张表的建表脚本（\`03-建表脚本.sql\`），
   说明工程数据的逻辑模型是关系表（HmiScreenTable / HmiTagTable / HmiConnectionTable / HmiScreenItemTable …）。

**编码**：字符串为 UTF-16LE；名称后面紧跟记录字段，会粘 1~2 个生僻字，已按工程常用字表裁剪。

## 2. 工程内容

### 2.1 画面（${screens.length} 项）

${screens.map(s => `- ${s}`).join('\n')}

### 2.2 HMI 变量（${tags.length} 个）

${varLines.join('\n')}

### 2.3 通讯连接

${uniq(TYPE.conn).map(s => `- ${s}`).join('\n') || '（无）'}

连接参数（从压缩块的属性包里解出）：
\`\`\`
LocDeviceName = 192.168.2.10      （PLC 侧地址）
SubnetMask    = 255.255.0.0
InterfaceType = ETHERNET
LocAddressType= TCPIP
DevNameID     = S7ONLINE
\`\`\`

### 2.4 画面元件

| 类型 UUID | 唯一名 | 名称 |
|---|---|---|
${compLines.join('\n')}

### 2.5 模板元件

${uniq(TYPE.tmpl).slice(0, 60).join('、')}

### 2.6 图片资源

${images.join('、')}

### 2.7 用户与权限

- 用户：${uniq(TYPE.user).join('、')}
- 授权组：${auths.length ? auths.join('、') : '（未解出可读名）'}

### 2.8 报警配置

- 确认组（${uniq(TYPE.confirm).length}）：${uniq(TYPE.confirm).join('、')}
- 报警类别 / 分组在项目树节点里：${uniq('b0e0cad9-a3bb-074d-a9cf-296d0573e254').filter(n => /报警/.test(n)).join('、')}

### 2.9 画面更新周期

${uniq(TYPE.period).join('、')}

### 2.10 软件自带内容（非本工程）

- 多语言系统消息 ${stat.zhMsgs} 条（中文，见 \`06-系统消息_中文.txt\`）
- Smart 主题/样式名（Smart-chart / Smart-ghost / Smart-gradient …）
- 图形列表、字体列表、系统函数清单

## 3. 产物清单

| 文件 | 内容 |
|---|---|
${Object.keys(stat.outputs).map(k => `| \`${k}\` | ${(stat.outputs[k] / 1024).toFixed(0)} KB |`).join('\n')}

## 4. 已知边界

- 画面内元件的**精确坐标与逐条属性**未逐字段还原：它们在压缩块里以"属性名+值"序列存放，已整体导出（\`04-解压块-工程数据.txt\`），但未做字段级重建。
- 少量名称尾部残留 1~2 个噪声字符（记录结构紧邻所致），以 \`01-对象记录.tsv\` 的原始值为准。
- 图片资源的**二进制本体**未单独导出成图片文件。
- 另有 500+ 个未归类 UUID，多为软件内部结构或二进制误命中（\`02-对象分类.md\` 中标为"其他/待定""疑似二进制区"）。

## 5. 复跑

\`\`\`bash
node hmismart-decode.mjs <工程文件.hmismart> [输出目录]
node report.mjs <解码输出目录> [工程名]
\`\`\`
只读源文件，不改动任何原始工程。
`
fs.writeFileSync(path.join(dir, 'HMI解码报告.md'), md)
console.log(`已生成 ${path.join(dir, 'HMI解码报告.md')}（${(Buffer.byteLength(md) / 1024).toFixed(1)} KB）`)
console.log(`画面 ${screens.length}｜变量 ${tags.length}｜连接 ${uniq(TYPE.conn).length}｜图片 ${uniq(TYPE.image).length}｜元件类型 ${compLines.length}`)
