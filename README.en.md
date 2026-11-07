# dsh-plc-decode

<img src="assets/icon-180.png" width="96" align="right" alt="dsh-plc-decode">

[中文](README.md) | **English**

Read PLC project files directly inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): the plugin detects the format from the file header, decodes the project into readable reports and structured data, and provides project diffing, address audits, element-level read/write analysis and ladder-logic reconstruction. The same plugin row also covers HMI projects: screens, controls, tags and addresses; for Weintek EasyBuilder Pro it reads the compiled output of the project and decodes screens, text objects, alarm events and text-library entries.

**Read-only**: project files are parsed, never modified.

## Supported files

| Header | Format | Decoder |
|---|---|---|
| `50 4B 03 04` (ZIP) | CoDeSys V3.5 / LeadSysStudio `.project` (incl. Leadshine) | Bundled Python script: unpack → string table → restore POU ST sources |
| `57 01 01 00` | Delta WPLSoft / ISPSoft `.dvp` | Bundled Python script: file structure / section comments / device comments / instruction table |
| `53 48 33 00` (SH3) | Siemens S7-200 SMART `.smart` | Embedded Node decoder: blocks / instruction records / operands / user and system symbol tables |
| `44 45 4D 00` (DEM) | Siemens S7-200 SMART `.smartlib` | Embedded Node decoder: library variables and comment stream |

> Leadshine LeadSysStudio saves CoDeSys-format `.project` files; they decode through the same path: ST sources go to `pous/<POU>.txt`, and `/codesys-check` runs an equivalent compile check (struct members, array bounds, calls, address uniqueness, undeclared symbols).

### HMI projects

| File | Brand | Decoded |
|---|---|---|
| `.hmismart` | Siemens WinCC flexible SMART (Smart Line) | Screens / objects / texts / devices; the sibling `{{GUID}}.data` files yield tag names, control names, binding candidates and the type table |
| `.fsprj` or a folder containing `HMI\Frame` | Flexem FStudio | Screens / controls / control addresses (from `HMI\System\fs2.s3db` and `Bin\fshmi.bin`) |
| `.nbp` | Omron NB-Designer | Screens / controls / addresses (XML) |
| `.mcp` / `.mcgs` | MCGS / LSTP Studio | Screens / tags / alarms / strategies (Access database) |
| `.emtp` / `.exob` | Weintek EasyBuilder Pro | Screens / text objects / alarm events / text library (the `.emtp` body is encrypted; the plugin reads the compiled `.exob` of the same project) |

## Install

Prerequisites:

- DSH desktop app (the plugin runs inside DSH; the Node version follows DSH);
- Python 3.9+ on `PATH` for `.project` / `.dvp` (standard library only, no `pip install`);
- Python is not needed for `.smart` / `.smartlib`;
- requires DSH >= 0.2.1-alpha.1 (lower bound inferred from the services and slots the plugin uses, all present in alpha.1); verified on 0.2.1-alpha.3 and 0.2.2-rc.1, later versions untested.

```sh
dsh plugin --profile web add github:taoziliyouchong/dsh-plc-decode
```

Restart DSH afterwards. The plugin has no npm runtime dependencies.

## Usage

### Tools (invoked by the model)

| Tool | Purpose |
|---|---|
| `plc-decode` | Unified entry: detect the four PLC formats and dispatch; args `file`, optional `outDir` |
| `smart-pou-structure` | Internal structure of one POU: interface parameters (L-area address + type), box-level instruction chain, call sites and arguments |
| `smart-lad` | Ladder reconstruction: per block and network, the LAD instruction sequence (LD/A/O/AN/ON, EU/ED, LPS/LRD/LPP, coils, comparisons, instruction-box placeholders) |
| `smart-ladder-elements` | Element-level read/write judgement for one address (or a batch) |
| `smart-net-trace` | Network trace: elements, write coils, boxes and constants in offset order |
| `smart-box-pins` | Box pin table: pin name = actual argument for library call boxes (MBUS_CTRL, MBUS_MSG, TON, CTU, MOV_*, …) |
| `smart-pin-dump` | Byte-level location: all occurrences of an address, or the operand records inside an offset range |
| `smart-var-usage` | Variable audit: all references, other address forms over the same bytes, write-point judgement |
| `smart-free-space` | Address usage and free ranges: pick new addresses before extending a program |
| `smart-conflict` | Address conflicts: overlaps (real / suspected / registered only) and fragmented free space |
| `smart-diff-project` | SMART project diff: block list, call chain, I/O references, symbol table |
| `codesys-diff-project` | CoDeSys project diff: POU list, real logic changes, whitespace, string table, object table |
| `hmi-decode` | HMI unified entry: identifies `.hmismart` / `.fsprj` / `.nbp` / `.mcp` / `.emtp` / `.exob` and processes it |
| `hmi-diff-project` | HMI project diff for two `.hmismart` files: start screen, screen records, screen names, companion files |
| `ebpro-decode` | Weintek EasyBuilder Pro: decode screens / text objects / alarm events / text library from the compiled `.exob` |
| `ladder-auto` | Auto ladder: read a `.smart` project and render box-style text ladders per block/network (`block`, `net`) |
| `ladder-dvp` | Delta `.dvp` → text ladder, optionally limited to a line range |
| `ladder-from-stl` | Statement list (STL) → text ladder plus a mechanical explanation per network |
| `ladder-render` | Render a network description (spec JSON) into the fixed text-ladder layout |

### Slash commands

| Command | Purpose |
|---|---|
| `/plc-decode <file> [outDir]` | Unified decode entry |
| `/plc-archive` | Show the effective archive root, the default target and how to change it |
| `/codesys-read <project>` | Decode a `.project` (ST sources + report) or a `.dvp` (report) |
| `/dvp-read <project>` | Delta DVP structure and instruction-table report |
| `/smart-read <.smart/.smartlib> [outDir]` | Decode a SMART project or library |
| `/codesys-check <project>` | Decode a `.project`, then run an equivalent static compile check |
| `/codesys-diff <old> <new>` | CoDeSys project diff |
| `/smart-diff <old> <new>` | SMART project diff |
| `/smart-free-space <.smart>` | Address usage and free ranges |
| `/smart-conflict <.smart>` | Address conflict audit |
| `/smart-ladder <.smart> [address]` | Element-level read/write judgement |
| `/smart-lad <.smart> [block] [network]` | Ladder reconstruction (LAD instruction sequence) |
| `/hmi-decode <.hmismart / .fsprj / .nbp / .mcp / .emtp / .exob> [outDir]` | HMI project decode |
| `/hmi-diff <old .hmismart> <new .hmismart>` | HMI project diff |
| `/ladder on\|off\|status` | Ladder switch (off by default; takes effect immediately) |
| `/ladder-auto <.smart> [block] [net] [out.txt]` | Render a `.smart` project |
| `/ladder-dvp <.dvp> [from] [to] [out.txt]` | Render a `.dvp` project |
| `/ladder-stl <stl.txt> [out.txt]` | Statement list → ladder + explanation |
| `/ladder-spec <spec.json> [out.txt]` | Render a spec JSON |
| `/plc-calibrate <format> <bytes or cmd:XX> <name> [note]` | Record an unresolved byte/opcode in the calibration table; later decodes use the name |

## Output

By default the plugin writes to `解码归档/<project folder name>/` in the **workspace** (the folder name is used rather than the file name, so same-named projects in different folders do not overwrite each other; when one folder holds several project files, `<folder>_<file>` is used). Pass `outDir` to override.

| Format | Main files |
|---|---|
| `.project` | `00-索引.md` (read this first), `pous/<POU>.txt` (ST sources), `工程内容报告.md`, `全部字符串.txt`, `对象表.md`, `项目树.md` |
| `.dvp` | `00-索引.md`, `解码报告.md` (structure / section comments / device comments / instruction table) |
| `.smart` / `.smartlib` | `00-目录.md` (read this first), `解码报告.md`, `程序.lad`, `元素记录.tsv`, `符号地址.tsv`, `分析.md`, `记录.json`, `字符串全录.txt` |
| `.hmismart` | `10-画面.tsv`, `11-元件.tsv`, `12-文本.tsv`, `13-设备.tsv`, `20-变量.data.tsv`, `21-控件.data.tsv`, `23-控件绑定.data.tsv`, `24-类型表.tsv` |
| `.fsprj` | `画面.tsv`, `控件.tsv`, `控件地址.tsv`, `变量.tsv` |
| `.nbp` / `.mcp` | `解码报告.md` plus screen/control (or tag/alarm/strategy) JSON |
| `.emtp` / `.exob` | `HMI解码/HMI解码报告.md` + `00-格式说明.md`, `10-画面.tsv`, `11-文字对象.tsv`, `12-报警事件.tsv`, `13-文字库.tsv`, `08-统计.json` |

### Ladder rendering (off by default)

Ladder tools are disabled by default so a plain decode does not add another set of tools:

- Turn on: `/ladder on` (immediate, no restart); off: `/ladder off`; status: `/ladder status`
- Or set `config: { ladder: true }` on this plugin's row in the profile `cordis.patch.yml` as the initial state
- While disabled, the ladder tools answer with a one-line hint; decoding is unaffected
- The first three decodes append a hint that ladder diagrams are available (1/3, 2/3, 3/3), then it stops; switch state and the counter live in `$DSH_HOME/ladder-state.json`

### Changing the archive root (no code change)

Add `archiveDir` to this plugin's row in the profile `cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

`archiveDir` is the archive **root**: a relative path resolves against the current session workspace, an absolute path is used as is; the default is `解码归档`. Restart DSH after changing it; `/plc-archive` shows the effective value, and `outDir` overrides it for a single run.

The smart `记录.json` is the input of the analysis tools (address usage, variable usage, …) and also the marker that identifies a decoded directory. The report header carries a **source fingerprint** (file size + mtime); re-check it after the project changes.

## Known limits

- HMI projects: `.hmismart` carries only the template skeleton — real screens and controls live in the sibling `{{GUID}}.data` (ES2RT stream). Tag names and control names can be decoded; control-to-tag references are recovered only for same-segment co-occurrence and UUID hits, the rest is reported as undecoded. Without tags, a FStudio project keeps control addresses only in the action table of `Bin\fshmi.bin`. MCGS decoding needs a sample to verify against.
- Weintek EasyBuilder Pro: the `.emtp` body is compressed and encrypted, so only the compiled `.exob` of the same project can be read; the tables reflect the project **at compile time** (recompile first if the project changed). The compiled output carries only the source language, no translations. Screen membership is inferred from object-stream segments; x/y/w/h in the tables are text-box metrics, not screen coordinates.
- Pin-level arguments of library call boxes (e.g. Slave / RW / Addr / Count / DataPtr of MBUS_MSG) cannot be decoded; the tools say so instead of guessing.
- Encrypted or specially compressed projects may fail to decode; the decoder reports an error rather than a half-true result.
- Ladder series/parallel topology is reconstructed from instruction records (validated network-by-network against official STL exports); library call regions without standard box headers are not covered.
- Inferred instruction names are marked with `?`; undecoded names keep the raw form `??xx`.

## Development

```sh
npm run check                 # syntax check
npm run smoke                 # load the plugin and verify registrations (19 tools / 20 commands)
npm run smoke -- <project>    # additionally decode one real project end-to-end
npm pack --dry-run            # inspect package contents (node_modules and publish/ must not be inside)
```

## Structure

```
index.js                     plugin entry: tool and command registration, format dispatch, SMART decoder
hmi.js                       HMI decoding module (tools/commands/skill registration, called by index.js)
ladder.js                    ladder rendering module (off by default, /ladder on; called by index.js)
assets/decode-pack.mjs       decoded-output writer (indexes, tables, records)
assets/smart-lad.mjs         ladder reconstruction script (used by smart-lad)
assets/smart-net-trace.mjs   network trace script (used by smart-net-trace)
assets/codesys-tools/        CoDeSys / DVP decoding Python scripts (standard library only)
assets/hmismart-decode.mjs   Siemens .hmismart decoder (structure tables + .data names/bindings)
assets/hmismart-report.mjs   .hmismart human-readable report (screens/tags/connections)
assets/hmismart-diff.mjs     .hmismart project diff
assets/fstudio-tables.py     FStudio screen / control / control-address tables
assets/fstudio_i18n.py       FStudio element-text scan (per language slot)
assets/hmi-decode-workflow.md  HMI reading workflow (skill text)
assets/nb-decode.mjs         Omron NB-Designer decoder
assets/mcgs-decode.mjs       MCGS / LSTP decoder
assets/ebpro-decode.mjs      Weintek EasyBuilder Pro decoder (from .exob)
assets/ladder-render.mjs     text-ladder renderer (used by ladder-render)
assets/stl-to-ladder.mjs     STL → ladder (used by ladder-from-stl)
assets/smart-ladder-auto.mjs .smart auto renderer (used by ladder-auto)
assets/dvp-ladder.mjs        .dvp auto renderer (used by ladder-dvp)
scripts/smoke.mjs            smoke test
```

## Feedback

- Open an issue: https://github.com/taoziliyouchong/dsh-plc-decode/issues — searchable, and others can help.
- Or reach me on QQ: **2171960697** (mention which plugin you installed when adding the contact).

Please include: DSH version, plugin version, the exact error text, and a screenshot.

## License

MIT
