# FStudio 触摸屏多语言翻译 · 工作流

适用：繁易 Flexem FStudio 的触摸屏工程（`.fsprj` + `HMI\Frame` + `Global\TextLibConfigInfo.cfg`）。
目标：让画面上的文字随语种切换而变。

## 一句话看清机制（先懂这个，省掉一半返工）

FStudio 里画面文字的显示有**两条路**：

1. **元件自带文字**：静态文本元件内部按语种分槽存字（`LanguageSN` 1 中文 / 2 英文 / 3 俄语），
   切语种时软件自动取对应槽。**存的是字本身，不是引用**。
2. **走文本库**：元件勾「使用文本库」并指向某条目，内容由文本库按语种提供。
   同一个词在多处引用同一条，改一处全局生效。

**实测经验**：这类工程的画面文字绝大多数走第 1 条路——库里只有几十条系统文本，元件上是写死的字。
「切语种不变」的根因是：**字没进文本库，元件也没勾引用**。

## 正确工作流（三步，别多）

### 第 1 步 · 扫（一次扫全，别一页页看）
插件工具 `fstudio-i18n`（或 `fstudio-scan-texts` 只看清单）。

- 扫什么：`HMI\Frame\**\*.wcfg` 里**所有**带语种文字的元件，两条路都要收：
  ① 静态文本：`StaticTextContentInfo` 的 `LanguageSN` + `LabelContent`；
  ② 按钮/开关/指示灯：`Tag/Statuses/TagStatus/TagStatusLanguage` 的 `LanguageId` + `Text`。
  **只扫 ① 会漏掉整批按钮标签**（2026-09-22 踩过：888 → 1899 个元件）。
- 同时读 `Global\TextLibConfigInfo.cfg` 看库里已有什么。
- 产出：`元件文本扫描.json` + 中文去重清单。

### 第 2 步 · 译（口径先定，再动手）
两条口径，开工前先问清用哪条（2026-09-22 一台设备上被改了三回）：

- **定版优先（默认）**：词典译文一律覆盖元件里原有的英文，术语统一、机翻味清掉。
  元件的原英文槽仍写进对照表第 6 列备查。
- **原件优先**：元件里原本有英文的一律沿用，只补空白项；只有当原件英文属于
  「词不达意 / 填错内容 / 张冠李戴」三类明显失误时才换成定版，并在表里标出来。
  （判据集合见插件 `fstudio_i18n.py` 的 `FORCE_FIX`。）

其余口径共通：
- **元件里"中文标签 ↔ 英文标签"成对的要点**——那是工程自带的人工译文，可作译法参考。
- 现场操作员扫一眼要懂；动词用设备惯用语（Start / Stop / Reset / Jog / Home）；
  厂名音译（拓宇机械 → Tuoyu Machinery）；单位与代号按行业写法（mm、°/s、packs/min、S/N、DHCP IP）。
- **注意**：原工程英文槽常有错填（同一画面几十条都写着 `current position`、`Platen`；
  甚至有把数字 `8` 当英文的），那是串槽不是译文。
- 外语比中文长、元件放不下的：按元件在屏上的可用宽度切成多行（真换行）；同一句中文全表一个切法（见入口技能「外语撑破控件就分段」）。

### 包装机术语口径（纸品包装线，2026-09-22 定）
先判断设备类型（画面名/工序词一看就知道），是包装机就按这套：

**产品层级（量词别混）**
| 实物 | 用词 | 说明 |
|---|---|---|
| 软抽小包（盒／包） | **pack** | 生产线成品单位；节拍写 `packs/min`（不要 boxes/min） |
| 瓦楞外箱（箱） | **carton** | `carton infeed / opening / stop / press cylinder` |
| 泛称"盒子" | 不用 box | box 是泛称，现场分不清层级；文档场景才用 |

**工序词（按行业叫法）**
| 中文 | 用 | 别用 |
|---|---|---|
| 上/下折封 | Top / Bottom folding seal | Top seal |
| 折角 | Corner tuck | Corner fold |
| 扯膜 | Film pull | Film tearing |
| 下膜／上膜 | Bottom / Top film | Lower / Upper film |
| 送卷、放卷 | Film unwind | Unwind speed |
| 压纸输送 | Paper press conveyor | Platen conveying |
| 推纸 | Paper pushing | Push paper |
| 打码 / 冲孔 | Coding / Perforation | Coder / Punching |
| 定长 / 追标 | Fixed length / Mark chasing | — |
| 单光电 / 双光电 | Single / Dual photocell | Single sensor |
| 测纸长 | Paper length measurement | Measure length |
| 产品规格 | Pack height / width / length | Tissue height |

仅校准工序与产品词；权限、网络、系统提示等非工艺词保持常规译法，别扩散。

### 食品包装机术语口径（气调保鲜 / 转盘灌装封口，2026-09-28 定）
先认设备：画面里有真空室、充气、封切的是**气调保鲜包装机**，有落杯/出杯/灌装/搅拌的是**转盘式灌装封口机**；同一工程的文本库常混着两类。

| 中文 | 用 | 中文 | 用 |
|---|---|---|---|
| 真空 / 充气 | Vácuo / Injeção de gás | 杯 / 盒 | copo / embalagem |
| 封切 / 封口 | Selagem e corte / Selagem | 落杯 / 出杯 | Queda do copo / Saída do copo |
| 收膜 | Tração do filme | 灌装 / 搅拌 | Enchimento / Mistura |
| 上真空室 | Câmara de vácuo superior | 打码 / 上胶 | Impressão de código / Colagem |
| 顶盒 | Elevação da embalagem | 上料 / 光电 | Alimentação / Fotocélula |

- **开／关成对词用同一词干 + Ligada/Desligada**（机械夹爪的开合用 Aberta/Fechada）。
- 开＝`Atraso Inicial`、关＝`Tempo Final`（软件原本就是这套写法）；`权限N`＝`Permissão N`。
- 葡语品牌词照抄不译：N2 / CO2 / O2 / OFF / ON / AT / I/O / WiFi / HMI / SD / Pen Drive。


### 第 3 步 · 出导入表（格式由代码保证）
`fstudio-i18n` 直接产出 `文本库导入表.xlsx`，列名与软件导出逐字符一致：

```
Guid | Name | Status | 1-Chinese (Simplified, PRC)-2052 | 2-English (United States)-1033
```

- 每行一个条目：Guid＝UUID4、Status＝数字 0（默认值节点）、Name 取中文前 50 字。
- **第三语种按工程实际声明的语种来**（看 `HMI\System\LanguageConfigInfo.cfg` 的 `Lcid`），列名逐字符照抄、别自己拼；只有中英就别加。插件 `LANG_HEADS` 已备好常用列名：`pt` = `3-Portuguese (Brazil)-1046`、`pt-pt` = `3-Portuguese (Portugal)-2070`、`ko` = `3-Korean (Korea)-1042`、`ru` = `3-Russian (Russia)-1049`、`es`/`vi`/`th`/`ar` 同理。**换语种（如去韩语上葡语）时列名里的 LCID 必须与软件里加的语种一致**，否则导进去列对不上。
- 多语词典写法：python 里加 `ELEMENT_PT`/`LONG_PT`（英表仍是 `ELEMENT_EN`/`LONG_EN`），或 json 写成 `{"en": {…}, "pt": {…}}`；只给英表就只出中英两列。
- 导入：FStudio 文本库 → 导入 → 选这份表。
- **状态要够数**：元件有 N 个状态（开关/指示灯/多状态按钮），挂库时取的是**库条目第 N 个状态**的内容；条目只有 1 个状态时，元件状态 1 就是空白（中文也空）。所以「开/关」「上一页/下一页」这类成对元件，条目必须做成多状态条目——导出表里表现为：首行带 Guid＋Status 0，后续状态行 **Guid 必须留空**＋Status 1/2、Name 与首行相同（重建/生成表时别顺手给后续状态行补 Guid，补了就不是同一条目的第二个状态了，2026-09-26 犯过、被用户当场看出）。单状态的元件用单状态条目即可；拿不准就把条目统一补到 2 状态，第二状态文字取成对词，没有成对词就与原状态同字（工程里原本就是这么写的：定位夹关→定位夹开 是成对，温度控制→温度控制 是同字）。
- 导入后逐元件勾「使用文本库」指到条目（FStudio 使用手册 4.13.8 标签编辑器，p.570-571）。

### 第 3 步的另一条路 · 已有导出表，只换语种列（retag）
工程里文本库已经建好、软件也能导出表时**别重扫工程**，直接把导出的 TextLib 表整列换语种：

```
python <插件>/assets/fstudio_i18n.py retag <导出的TextLib表.xls> <输出.xlsx> <词典.json> pt 2
# 或工具/命令：fstudio-retag <源表> <词典.json> [输出.xlsx] [语种键] [最少状态数]
#                                                        ↑ 写 2 = 状态不够的条目补到 2 状态
```

- **只动第 6 列**：Guid、Name、Status、中文列、英文列逐行原样；多状态行的「首行带 Guid＋Status 0、后续行 Guid 留空＋Status 递增」结构照原样保留（软件导出的就是这个结构，别顺手给后续行补 Guid）。
- 译文按**该行自己的中文列**取，不是按条目首行——多状态条目第二条常是成对词（成型关→成型开 译成 `Moldagem Desligada` / `Moldagem Ligada`）。
- **状态数不够就补（最少状态数参数）**：屏上开关/指示灯是双状态元件，库条目只有一个状态时状态 1 会显示空白。补出来的行 Guid 留空、Status 递增、各语种文字与**首行相同**（软件导出的表里就是这么写的，不自己造词）。
- 交付前机器校验四条：行数一致、前 5 列逐行一致、第三列无空/无汉字/无旧语种残留、抄参考表的译文与参考表逐字一致。

### 要保留原表格式：就地改，走 Excel COM
换语种列若要求「格式与原表一致」（用户会这么说），别用 xlwt/openpyxl 另存——**用 Excel COM 打开原件改再保存**，列宽/字体/合并等原样保留。要点与坑：

- 改前先备份原件（`*.原件备份.xls`），中途出错直接从备份恢复重做。
- **`Rows.Insert` 的 CopyOrigin 只管格式来源，不搬内容**——新行是空的，得自己把上一行的 `Range(...).Value` 搬过去（第一版只设了 CopyOrigin，三行全空，被"缺译 3"提示逮住）。插多行时**从下往上插**，行号才不漂。
- 批量写值要**整块赋值**（`Range(A1:A9).Value = tuple(...)`），逐格 COM 往返慢十倍。
- 写完 Excel 会把列宽/行高按字符重算（列宽 ±10/256 字符、行高 255→250 twips）：列宽用 `Columns(c).ColumnWidth = 原值`（Excel 单位）写回，行高用 `Rows("1:N").RowHeight = 12.75`（=255 twips）写回，写回后与原件一致。
- 判"格式一致"要用 Excel 的口径（COM 读 `ColumnWidth`/`RowHeight`），别拿 xlrd 的 1/256 原始值硬比——那是文件内部表示，差几十分之一字符是重存的取整差。
- 控件：`DispatchEx("Excel.Application")` 开独立实例、`Visible=False`、`DisplayAlerts=False`，`finally` 里 `Quit()`；别 `taskkill excel`（用户可能自己开着 Excel）。
- **词典不一定要留**：改好的表里「中文列 ↔ 目标语种列」本身就是词典，要复用就从成品表反推，不必额外存一份。

## 踩过的坑（照这个避）

| 坑 | 现象 | 正解 |
|---|---|---|
| 列名不一致 | 导入报「文件格式不正确」 | 表头逐字符对；第 4 列是中英混排长名，不能写成「中文」 |
| 以为要逐页看 | 大量时间翻画面 | 元件文本一次全扫，上千条几秒出 |
| 拿元件英文槽当译文 | 译文一堆重复的 current position / Platen | 先查"同一英文被多少中文共用"，共用多的是串槽，按中文重译 |
| 自己造表 | 交出去导不进 | 用插件出表，格式由代码保证 |
| 一次交多个表 | "怎么又三个表格" | **只交最终能用的那一份**；对照表仅在你需要核对时才给 |
| 「切韩语/俄语什么都不显示」 | 文本库三语都填了，屏上还是空白 | 按顺序查三处：① **元件语种槽有没有字**（本机实测 494 个元件只有 30 个韩文槽有字，275 个连韩语槽都没有）；② **元件有没有勾「使用文本库」**（30 个画面里只有 4 个用到库，光导库画面上什么都没变）；③ **该语种的字体**——工程 `HMI\System\LanguageConfigInfo.cfg` 每行一个字体，实测三行的字体类型都是「图形字体」（＝按字符串截位图存工程，多语种拿不到字模），且韩语行写的 `Microsoft YaHei` 经 cmap 表实测**不含韩文**（宋体、Arial 也不含；Malgun Gothic 含）。正解：该语种字体类型改**矢量字体**、字体换成含目标语言的（韩文用 Malgun Gothic），再重新下载工程（字模随工程打包）。判据：读字体文件 cmap 表查 U+AC00（韩文）／U+0400（西里尔）是否在覆盖区间内 |
| 以为元件"挂了库"就会跟着库翻译 | 数出一堆带 TextLibId 的元件，以为导入文本库就能上英文 | 拷贝元件会连着上一条的 `TextLibId` 一起复制。先把每个 TextLibId 解到条目、与元件自身文字比对：对不上的就是拷贝残留（本机实测 494 个元件里 107 个带 TextLibId，98 个能解出条目，其中 **97 个全指向同一条**）。导入库≠上屏，还要逐元件勾「使用文本库」 |
| 默认带俄语 | "不需要俄语" | 先确认语言范围；不要就不出那列 |
| 译文写死在脚本里 | 改词要动代码 | 词典单独一个文件（`ELEMENT_EN`/`LONG_EN` 或 json），脚本只调用 |

## 交付约定

- 交付目录（你取用处）**只放最终可用件**：`文本库导入表.xlsx`。
- 过程件（扫描 JSON、对照表、脚本）留在 `解码归档\<工程名>\` 或插件内。
- 工程原件只读；不写 `Global\TextLibConfigInfo.cfg`、不改 `.wcfg`。

## 词典

插件不带词典也能跑（会列出缺译文的中文条目）。给某台设备配词典就写一个 py 文件：

```python
ELEMENT_EN = {"拓宇机械": "Tuoyu Machinery", "进料1速度": "Feed 1 speed"}
LONG_EN = {"说明：...": "Note: ..."}   # 长句放这里
ELEMENT_PT = {"定位夹": "Garra de Posicionamento"}   # 第三语种按语种键命名：PT / KO / RU / ES…
LONG_PT = {}
```

```json
{"en": {"启动1": "Start 1"}, "pt": {"启动1": "Partida 1"}}
```

再用 `fstudio-i18n` / `fstudio-retag` 的 `dict` 参数传入。
