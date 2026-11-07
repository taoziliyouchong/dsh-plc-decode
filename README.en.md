# dsh-plc-decode

[中文](README.md) | **English**

Read PLC project files directly inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). The plugin detects the format from the file header, decodes the project into readable reports and structured data, and provides project diffing, address audits, element-level read/write analysis and ladder-logic reconstruction.

**Read-only**: project files are parsed, never modified.

## Supported formats

| Header | Format | Decoder |
|---|---|---|
| `50 4B 03 04` (ZIP) | CoDeSys V3.5 / LeadSysStudio `.project` (incl. Leadshine) | Bundled Python script: unpack → string table → restore POU ST sources |
| `57 01 01 00` | Delta WPLSoft / ISPSoft `.dvp` | Bundled Python script: structure / section comments / device comments / instruction table |
| `53 48 33 00` (SH3) | Siemens S7-200 SMART `.smart` | Embedded Node decoder: blocks / instruction records / operands / user & system symbol tables |
| `44 45 4D 00` (DEM) | Siemens S7-200 SMART `.smartlib` | Embedded Node decoder: library variables and comment stream |

> Leadshine LeadSysStudio saves CoDeSys-format `.project` files, so they decode through the same path: ST sources go to `pous/<POU>.txt`, and `/codesys-check` runs an equivalent compile check (struct members, array bounds, calls, address uniqueness, undeclared symbols).

## Install

Prerequisites:

- DSH desktop app (the plugin runs inside DSH; Node version follows DSH);
- Python 3.9+ on `PATH` for `.project` / `.dvp` (standard library only, no `pip install`);
- Python is not needed for `.smart` / `.smartlib`.
- Requires DSH >= 0.2.1-alpha.3; verified on 0.2.1-alpha.3 and 0.2.2-rc.1, later versions untested.

```sh
dsh plugin --profile web add github:taoziliyouchong/dsh-plc-decode
```

Restart DSH afterwards. The plugin has no npm runtime dependencies.

## Usage

### Tools (invoked by the model)

| Tool | Purpose |
|---|---|
| `plc-decode` | Unified entry: detect the four formats and dispatch; args `file`, optional `outDir` |
| `smart-pou-structure` | Internal structure of one POU: interface parameters (L-area address + type), box-level instruction chain, call sites and arguments |
| `smart-lad` | Ladder reconstruction: per block/network LAD instruction sequence (LD/A/O/AN/ON, EU/ED, LPS/LRD/LPP, coils, comparisons, instruction-box placeholders) |
| `smart-ladder-elements` | Element-level read/write judgement for one address (or a batch) |
| `smart-net-trace` | Network trace: elements, write coils, boxes and constants in offset order |
| `smart-box-pins` | Box pin table: pin name = actual argument for library call boxes (MBUS_CTRL, MBUS_MSG, TON, CTU, MOV_*, …) |
| `smart-pin-dump` | Byte-level location: all occurrences of an address, or operand records in an offset range |
| `smart-var-usage` | Variable audit: all references, overlapping byte forms, write-point judgement |
| `smart-free-space` | Address usage and free ranges: pick new addresses when extending a program |
| `smart-conflict` | Address conflicts: overlaps (real / suspected / registered only) and fragmented free space |
| `smart-diff-project` | SMART project diff: block list, call chain, I/O references, symbol table |
| `codesys-diff-project` | CoDeSys project diff: POU list, real logic changes, whitespace, string table, object table |

### Slash commands

`/plc-decode`, `/codesys-read`, `/dvp-read`, `/smart-read`, `/codesys-check`, `/codesys-diff`, `/smart-diff`, `/smart-free-space`, `/smart-conflict`, `/smart-ladder`, `/smart-lad`.

## Output

Decoded files go to `解码归档/<project folder name>/` (the literal folder name is Chinese for "decode archive"; it lives in the current workspace). Use `outDir` to override.

- `.project` → `00-索引.md`, `pous/<POU>.txt`, `工程内容报告.md`, `全部字符串.txt`, `对象表.md`, `项目树.md`
- `.dvp` → `00-索引.md`, `解码报告.md`
- `.smart` / `.smartlib` → `00-目录.md`, `解码报告.md`, `程序.lad`, `元素记录.tsv`, `符号地址.tsv`, `分析.md`, `记录.json`, `字符串全录.txt`

The smart decoder writes a source fingerprint (size + mtime) into the report and `记录.json`; re-check it after the project is edited.

## Limitations

- HMI projects (`.hmismart`, `.fsprj`, `.nbp`, `.mcp`) are decoded by the same plugin row: screens / controls / tags / addresses, tables written to `解码归档/<project>/`. Control-to-tag references in `.hmismart` are partial (only same-segment and UUID hits); the rest is reported as "未解出".
- Pin-level arguments of library call boxes (Slave / RW / Addr / Count / DataPtr) cannot be decoded; the tools say so instead of guessing.
- Encrypted or specially compressed projects may fail to decode; the decoder reports an error rather than a half-true result.
- Ladder series/parallel topology is reconstructed from instruction records (validated network-by-network against official STL exports); library call regions without standard box headers are not covered.
- Inferred instruction names are marked with `?`; undecoded names keep their raw form `??xx`.

## Development

```sh
npm run check                # syntax check
npm run smoke                # load the plugin and verify registrations (12 tools / 11 commands)
npm run smoke -- <project>   # decode one real project end-to-end
npm pack --dry-run           # inspect package contents
```

## Feedback

- Open an issue: https://github.com/taoziliyouchong/dsh-plc-decode/issues — searchable, and others can help.
- Or reach me on QQ: **2171960697** (mention which plugin you installed when adding the contact).

Please include: DSH version, plugin version, the exact error text, and a screenshot.

## License

MIT
