/**
 * ladder —— 文字梯形图渲染 + 自动成图（模块，由 index.js 调用）
 * 默认关闭；开：/ladder on（立即生效）或 profile 配置 ladder: true。
 *
 * 两件事：
 *   1) ladder-render     给"网络描述"→ 软件观感的文字梯形图（方框＋两侧引脚＋导线值）
 *   2) ladder-from-stl   给 S7-200/SMART 语句表 → 每个网络的文字梯形图 + 机械讲解
 *
 * 为什么要有它：2026-09-18 用户认可了这一版式，并要求"保证要输出这种质量"——
 *   手敲空格会对不齐、换会话会换风格；把版式固化成代码后，样式不会再漂。
 *
 * 只读输入 + 可选写出文本文件；不改动任何工程文件。
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { renderSpec, lintSpec } from './assets/ladder-render.mjs'
import { stlToLadder } from './assets/stl-to-ladder.mjs'
import { autoLadder } from './assets/smart-ladder-auto.mjs'
import { dvpLadder } from './assets/dvp-ladder.mjs'

/** 梯形图功能开关：默认关闭；状态存 $DSH_HOME/ladder-state.json，/ladder on|off 切换，立即生效。 */
const STATE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ladder-state.json')
const HINT_LIMIT = 3
const OFF_TEXT = '梯形图功能未开启。开启：/ladder on（立即生效），或在 profile 的 cordis.patch.yml 里给本插件行加 config ladder: true 后重启。'
let ladderOn = false

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function patchState(patch) {
  try { writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }), 'utf8') } catch { /* 状态写不进去不影响渲染 */ }
}
function setLadderOn(v) { ladderOn = Boolean(v); patchState({ enabled: ladderOn }) }
export function ladderEnabled() { return ladderOn }
/** 解码后提示（默认关闭时前三次提示「可以看梯形图」，之后不再提示）。 */
export function maybeLadderHint() {
  if (ladderOn) return ''
  const st = readState()
  const n = Number(st.hints) || 0
  if (n >= HINT_LIMIT) return ''
  patchState({ hints: n + 1 })
  return `\n\n提示：这个工程可以出梯形图（按块/网络画成文字图）。要开就说 /ladder on，开启后随时可看（第 ${n + 1}/${HINT_LIMIT} 次提示）。`
}

/* ---------- 台达：先跑解码器拿结构化指令表，再画图（数据源与报告同一份） ---------- */
const PY = 'python'
const DVP_DECODER = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'codesys-tools', 'dvp_decode.py')
let CTX = null
function psq(v) { return `'${String(v).replace(/'/g, "''")}'` }
async function runPy(script, argv, workdir, exec) {
  const policy = CTX?.sandboxPolicy && exec?.agent ? CTX.sandboxPolicy.resolve({ session: exec.agent.session }) : undefined
  const spec = CTX.shell.resolve({
    command: `$env:PYTHONIOENCODING='utf-8'; & ${PY} ${psq(script)} ${argv.map(psq).join(' ')}`,
    workdir,
    timeoutMs: 300000,
    ...(policy ? { sandboxPolicy: policy } : {}),
    ...(exec?.signal ? { signal: exec.signal } : {}),
  })
  const res = await (await CTX.shell.execute(spec)).result()
  return { out: String(res.stdout?.text ?? '').trim(), err: String(res.stderr?.text ?? '').trim(), exitCode: res.exitCode }
}
async function decodeDvpToJson(file, exec) {
  const abs = resolve(file)
  const dir = mkdtempSync(join(tmpdir(), 'dvp-il-'))
  const json = join(dir, 'insts.json')
  const r = await runPy(DVP_DECODER, [abs, '--json', json], dirname(abs), exec)
  if (r.exitCode !== 0) throw new Error(`DVP 解码失败（退出码 ${r.exitCode}）：${r.err || r.out}`)
  return json
}

/** 随包技能：文字梯形的排版规范与自动成图。 */
const SKILLS = [
  { name: 'ladder-workflow', file: 'ladder-workflow.md', description: '文字梯形图排版与自动成图：STL/工程文件转图、按 spec 渲染、交付前自检' },
]

const SPEC_HINT = 'spec = { title?, legend?, outFile?, networks: [ { name, note?, rows: [ { left?, pinL?, pinR?, out? } ], comments?, plain? } ] }'

/** 从 spec 渲染；顺带做结构自检（发现问题不改写，附在文本末尾便于当场改）。 */
function render(spec) {
  const text = renderSpec(spec)
  const issues = lintSpec(spec)
  return issues.length ? `${text}\n（结构自检 ${issues.length} 条：${issues.join('；')}）\n` : text
}

/** 注册工具、命令与内置技能（默认关闭；关着时工具只回一行开启提示）。 */
export function apply(ctx, config = {}) {
  CTX = ctx
  const st = readState()
  ladderOn = typeof st.enabled === 'boolean' ? st.enabled : config.ladder === true
  const regTool = (def) => ctx.tools.register({ ...def, execute: (args, exec) => (ladderOn ? def.execute(args, exec) : { ok: true, text: OFF_TEXT }) })
  const regCmd = (def) => ctx.commands.register({ ...def, handler: async (e) => (ladderOn ? def.handler(e) : { kind: 'error', text: OFF_TEXT }) })

  regTool({
    name: 'ladder-render',
    description: '把网络描述渲染成软件观感的文字梯形图（触点/导线在左、指令盒画方框、引脚列两侧、值写在导线上）。用于任何要交"文字梯形图"的场合：PLC 程序讲解、改动方案、对照说明。样式固定、对齐由本工具计算（中文只在标题与说明行），排版不会再漂。传 spec JSON：networks[].rows[] 的 left=方框左侧的导线与触点（如 "Alw~:SM0.0 ──┤ ├"）、pinL/pinR=方框左右引脚名（如 EN/ENO）、out=方框右侧去向（如 VW198）；comments[] 是网络下方的说明行。可选 outFile 直接写盘。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '整份输出的标题（可选）。' },
        legend: { type: 'boolean', description: '是否在图例行（默认 true，用固定那行符号说明）。' },
        outFile: { type: 'string', description: '可选：把渲染结果写入该文件（UTF-8）。' },
        networks: {
          type: 'array',
          description: '网络数组，按数组顺序渲染。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '网络标题，如 "网络 6"。' },
              note: { type: 'string', description: '标题后的补充，如 "MOV_W（每个扫描周期都执行）"。' },
              rows: {
                type: 'array',
                description: '行数组；一行画一根导线。',
                items: {
                  type: 'object',
                  properties: {
                    left: { type: 'string', description: '方框左侧的导线与元件。触点画成 ┤ ├（常开）、┤P├（上升沿）、┤==I +0├（比较）；只写 ASCII 与制表符，不要混中文。' },
                    pinL: { type: 'string', description: '方框左侧引脚名（软件的英文名，如 EN、First、DataPtr）。' },
                    pinR: { type: 'string', description: '方框右侧引脚名（如 ENO、Done、Error）。' },
                    out: { type: 'string', description: '方框右侧导线的去向（如 VW198、M0.1）；只写地址/符号，不写中文。' },
                  },
                  additionalProperties: false,
                },
              },
              comments: { type: 'array', items: { type: 'string' }, description: '网络下方的说明行（中文写在这里）。' },
              plain: { type: 'boolean', description: '该网络没有指令盒（例如直接以线圈结尾）时设 true：每行只画导线，不画方框。' },
            },
            required: ['name', 'rows'],
            additionalProperties: false,
          },
        },
      },
      required: ['networks'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const text = render({ ...args })
      const outFile = String(args.outFile ?? '').trim()
      if (outFile) {
        try { writeFileSync(resolve(outFile), text, 'utf8') } catch (e) {
          throw new Error(`写入失败 ${outFile}: ${e instanceof Error ? e.message : String(e)}`)
        }
        return { ok: true, text: `${text}\n（已写入 ${resolve(outFile)}）` }
      }
      return { ok: true, text }
    },
  })

  regTool({
    name: 'ladder-from-stl',
    description: '把西门子 S7-200 / S7-200 SMART 语句表（STL）自动转成文字梯形图＋机械讲解：认 LD/LDN、A/AN、O/ON、ALD/OLD/LPS/LRD/LPP、EU/ED、比较触点（LDD=／AD<>／OW> 与 ==I／<D 两种写法）、=、S/R、CALL、MOV_/TON/CTU/算术等指令盒。输出风格与 ladder-render 一致（触点与导线在左、盒画方框、引脚列两侧、值写在导线上），每个网络后附一句"当……时，……"的机械讲解（不编造：认不出的写法按盒原样画并标注）。传 stl=语句表正文，或 file=.awl/.txt 路径；可选 outFile 写盘、summary=false 关掉讲解行。',
    parameters: {
      type: 'object',
      properties: {
        stl: { type: 'string', description: '语句表正文（与 file 二选一）。' },
        file: { type: 'string', description: '语句表文件路径（.awl/.txt，与 stl 二选一）。' },
        outFile: { type: 'string', description: '可选：把结果写入该文件（UTF-8）。' },
        summary: { type: 'boolean', description: '是否输出机械讲解行（默认 true）。' },
        title: { type: 'string', description: '可选标题。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      let src = String(args.stl ?? '')
      const file = String(args.file ?? '').trim()
      if (!src && file) {
        try { src = readFileSync(resolve(file), 'utf8') } catch (e) {
          throw new Error(`读取失败 ${file}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (!src.trim()) throw new Error('需要 stl（正文）或 file（路径）')
      const text = stlToLadder(src, { summary: args.summary !== false, title: args.title })
      const outFile = String(args.outFile ?? '').trim()
      if (outFile) {
        writeFileSync(resolve(outFile), text, 'utf8')
        return { ok: true, text: `${text}\n（已写入 ${resolve(outFile)}）` }
      }
      return { ok: true, text }
    },
  })

  regTool({
    name: 'ladder-dvp',
    description: '台达 DVP 工程（.dvp）直接出盒式文字梯形图：读工程程序区，按行（LD M1000 行首）还原成「母线＋多支路」梯形图，版式与西门子 .smart 那侧同一个渲染器。不用导出指令表、不用手画。并联输出按字节里的分支/栈记录还原；触点常开常闭按前缀推定（0x22/0x24＝常闭，B 系＝上升沿、C 系＝下降沿），未定名功能码按 ?? 原样画盒并在图下注明。参数 file=工程路径、from/to=只出某几行（行号从 1 起）、outFile=写盘。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.dvp 工程文件路径。' },
        from: { type: 'number', description: '可选：起始行号（从 1 起）。' },
        to: { type: 'number', description: '可选：结束行号。' },
        outFile: { type: 'string', description: '可选：把结果写入该文件（UTF-8）。' },
        title: { type: 'string', description: '可选标题。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const json = await decodeDvpToJson(String(args.file ?? '').trim(), exec)
      const text = await dvpLadder({
        json,
        from: args.from,
        to: args.to,
        title: args.title,
        outFile: String(args.outFile ?? '').trim() || undefined,
      })
      const outFile = String(args.outFile ?? '').trim()
      if (outFile) return { ok: true, text: `${text}\n（已写入 ${resolve(outFile)}）` }
      return { ok: true, text }
    },
  })

  regTool({
    name: 'ladder-auto',
    description: '自动画梯形图：直接读西门子 S7-200 SMART 的 .smart 工程，按块（可选单网络）自动生成软件观感的盒式文字梯形图——母线、触点（含常闭/边沿）、比较触点（双操作数内联）、S/R/=/线圈、并联支路自动折叠，指令盒画占位框（BOX#位次，实参用 smart-box-pins 查）。输入 file=工程路径、block=块名（可选）、net=网络号（可选）、outFile=可选写盘。无需手写 spec、无需导出 STL。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.smart 工程文件路径。' },
        block: { type: 'string', description: '可选：块名（如 启停／主程序）；不填默认第一个块。' },
        net: { type: 'string', description: '可选：只画该块的第 N 个网络。' },
        outFile: { type: 'string', description: '可选：把结果写入该文件（UTF-8）。' },
        title: { type: 'string', description: '可选标题。' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const text = await autoLadder({ file: String(args.file ?? '').trim(), block: args.block ? String(args.block).trim() : undefined, net: args.net ? String(args.net).trim() : undefined, title: args.title })
      const outFile = String(args.outFile ?? '').trim()
      if (outFile) {
        writeFileSync(resolve(outFile), text, 'utf8')
        return { ok: true, text: `${text}\n（已写入 ${resolve(outFile)}）` }
      }
      return { ok: true, text }
    },
  })

  regCmd({
    name: 'ladder-dvp',
    description: '.dvp 工程 → 盒式文字梯形图（自动出图，无需 spec）',
    input: { hint: '<工程.dvp> [起行] [止行] [输出.txt]' },
    handler: async ({ rawInput }) => {
      try {
        const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        if (!parts.length) throw new Error('用法: /ladder-dvp <工程.dvp> [起行] [止行] [输出.txt]')
        const [file, from, to, out] = parts
        const json = await decodeDvpToJson(file)
        const text = await dvpLadder({ json, from, to, outFile: out })
        return { kind: 'success', text: out ? `${text}\n（已写入 ${resolve(out)}）` : text }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  regCmd({
    name: 'ladder-auto',
    description: '.smart 工程 → 盒式文字梯形图（自动出图，无需 spec）',
    input: { hint: '<工程.smart> [块名] [网络号] [输出.txt]' },
    handler: async ({ rawInput }) => {
      try {
        const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        if (!parts.length) throw new Error('用法: /ladder-auto <工程.smart> [块名] [网络号] [输出.txt]')
        const [file, block, net, out] = parts
        const text = await autoLadder({ file, block, net })
        if (out) writeFileSync(resolve(out), text, 'utf8')
        return { kind: 'success', text: out ? `${text}\n（已写入 ${resolve(out)}）` : text }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  regCmd({
    name: 'ladder-spec',
    description: '把 spec JSON 渲染成文字梯形图（软件观感：方框＋两侧引脚＋导线值）',
    input: { hint: '<spec.json> [输出.txt]' },
    handler: async ({ rawInput }) => {
      try {
        const raw = String(rawInput ?? '').trim()
        if (!raw) throw new Error(`用法: /ladder-spec <spec.json> [输出.txt]；${SPEC_HINT}`)
        const [file, out] = raw.split(/\s+/)
        const spec = JSON.parse(readFileSync(resolve(file), 'utf8'))
        const text = render(spec)
        if (out) writeFileSync(resolve(out), text, 'utf8')
        return { kind: 'success', text: out ? `${text}\n（已写入 ${resolve(out)}）` : text }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  regCmd({
    name: 'ladder-stl',
    description: '语句表（STL）→ 文字梯形图＋讲解',
    input: { hint: '<语句表.txt> [输出.txt]' },
    handler: async ({ rawInput }) => {
      try {
        const [file, out] = String(rawInput ?? '').trim().split(/\s+/)
        if (!file) throw new Error('用法: /ladder-stl <语句表.txt> [输出.txt]')
        const text = stlToLadder(readFileSync(resolve(file), 'utf8'), {})
        if (out) writeFileSync(resolve(out), text, 'utf8')
        return { kind: 'success', text: out ? `${text}\n（已写入 ${resolve(out)}）` : text }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'ladder',
    description: '梯形图功能开关：on 打开 / off 关闭 / status 查看（立即生效，不用重启）',
    input: { hint: 'on | off | status' },
    handler: async ({ rawInput }) => {
      const arg = String(rawInput ?? '').trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        setLadderOn(arg === 'on')
        return { kind: 'success', text: `梯形图已${arg === 'on' ? '开启' : '关闭'}（立即生效）。` }
      }
      return { kind: 'success', text: `梯形图当前：${ladderOn ? '开启' : '关闭'}。用法：/ladder on|off` }
    },
  })

  ctx.skills.registerProvider(() => ({
    name: 'ladder',
    list: () => Promise.resolve(SKILLS.map(s => ({
      name: s.name,
      description: s.description,
      invocation: { modelInvocable: false, userInvocable: true },
      provider: 'ladder',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: new URL('./assets/', import.meta.url).pathname },
      rank: BUNDLED_SKILL_RANK,
      locator: new URL(`./assets/${s.file}`, import.meta.url),
    }))),
    async get(candidate) {
      const s = SKILLS.find(x => x.name === candidate.name) ?? SKILLS[0]
      return { ...candidate, content: readFileSync(new URL(`./assets/${s.file}`, import.meta.url), 'utf8') }
    },
  }))

}
