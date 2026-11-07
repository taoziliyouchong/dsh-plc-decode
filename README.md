# dsh-plc-decode

<img src="assets/icon-180.png" width="96" align="right" alt="dsh-plc-decode">

**涓枃** | [English](README.en.md)

鍦?[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)锛圖SH锛夐噷鐩存帴璇?PLC 宸ョ▼鏂囦欢锛氭寜鏂囦欢澶磋嚜鍔ㄨ瘑鍒牸寮忥紝鎶婂伐绋嬭В鎴愬彲璇绘姤鍛婁笌缁撴瀯鍖栨暟鎹紝鍐嶅熀浜庤В鐮佺粨鏋滃仛鏂版棫瀵规瘮銆佸湴鍧€浣撴銆佸厓绱犵骇璇?鍐欏垽瀹氫笌杩炵嚎杩樺師銆傚悓涓€鎻掍欢琛岄噷涔熸壙鎺ヨЕ鎽稿睆锛圚MI锛夊伐绋嬶細鐢婚潰銆佹帶浠躲€佸彉閲忎笌鍦板潃锛涘▉绾堕€?EasyBuilder Pro 宸ョ▼璇诲悓宸ョ▼鐨勭紪璇戜骇鐗╋紝瑙ｅ嚭鐢婚潰銆佹枃瀛楀璞°€佹姤璀︿簨浠朵笌鏂囧瓧搴撴潯鐩€?
**鍙**锛氳В鏋愬伐绋嬫枃浠讹紝涓嶆敼鍔ㄥ師鏂囦欢銆?
## 鏀寔鐨勫伐绋嬫枃浠?
| 鏂囦欢澶?| 鏍煎紡 | 瑙ｇ爜鏂瑰紡 |
|---|---|---|
| `50 4B 03 04`锛圸IP锛?| CoDeSys V3.5 / LeadSysStudio `.project`锛堝惈闆疯禌锛?| 鑷甫 Python 鑴氭湰锛氳В鍖?鈫?瀛楃涓茶〃 鈫?閫愬璞℃仮澶?POU ST 婧愮爜 |
| `57 01 01 00` | 鍙拌揪 WPLSoft / ISPSoft `.dvp` | 鑷甫 Python 鑴氭湰锛氭枃浠剁粨鏋?/ 娈佃惤娉ㄩ噴 / 璁惧娉ㄩ噴 / 鎸囦护琛ㄥ弽姹囩紪 |
| `53 48 33 00`锛圫H3锛?| 瑗块棬瀛?S7-200 SMART `.smart` 宸ョ▼ | 鍐呭祵 Node 瑙ｇ爜鍣細鍧?/ 鎸囦护璁板綍 / 鎿嶄綔鏁?/ 鐢ㄦ埛涓庣郴缁熺鍙疯〃 |
| `44 45 4D 00`锛圖EM锛?| 瑗块棬瀛?S7-200 SMART `.smartlib` 搴?| 鍐呭祵 Node 瑙ｇ爜鍣細搴撳彉閲忎笌娉ㄩ噴娴?|

> 闆疯禌锛圠eadshine锛夌敤 LeadSysStudio 淇濆瓨鐨?`.project` 涓?CoDeSys 鍚屾牸寮忥紝璧板悓涓€鏉¤В鐮侀摼锛歋T 婧愮爜瀵煎嚭鍒?`pous/<POU>.txt`锛屽彲鐢?`/codesys-check` 鍋氱瓑浠风紪璇戞牎楠岋紙缁撴瀯浣撴垚鍛樸€佹暟缁勪笅鏍囥€佽皟鐢ㄥ瓨鍦ㄦ€с€佸湴鍧€鍞竴銆佹湭澹版槑绗﹀彿锛夈€?
### 瑙︽懜灞忥紙HMI锛夊伐绋?
| 鏂囦欢 | 鍝佺墝 | 瑙ｅ嚭 |
|---|---|---|
| `.hmismart` | 瑗块棬瀛?WinCC flexible SMART锛圫mart Line 灞忥級 | 鐢婚潰 / 鍏冧欢 / 鏂囨湰 / 璁惧琛紱鏃佺郴 `{{GUID}}.data` 閲岃В鍙橀噺鍚嶃€佹帶浠跺悕銆佺粦瀹氬€欓€夈€佺被鍨嬭〃 |
| `.fsprj` 鎴栧惈 `HMI\Frame` 鐨勭洰褰?| 绻佹槗 FStudio / Flexem | 鐢婚潰 / 鎺т欢 / 鎺т欢鍦板潃锛堣 `HMI\System\fs2.s3db` 涓?`Bin\fshmi.bin`锛?|
| `.nbp` | 娆у榫?NB-Designer | 鐢婚潰 / 鎺т欢 / 鍦板潃锛圶ML 鐩磋锛?|
| `.mcp` / `.mcgs` | 鏄嗕粦閫氭€?MCGS / LSTP Studio | 鐢婚潰 / 鍙橀噺 / 鎶ヨ / 绛栫暐锛圓ccess 搴擄級 |
| `.emtp` / `.exob` | 濞佺憾閫?EasyBuilder Pro | 鐢婚潰 / 鏂囧瓧瀵硅薄 / 鎶ヨ浜嬩欢 / 鏂囧瓧搴擄紙`.emtp` 鏈綋鍔犲瘑璇讳笉鍔紝璇诲悓宸ョ▼缂栬瘧浜х墿 `.exob`锛?|

## 瀹夎

鍓嶆彁锛?
- DSH 妗岄潰绔紙鎻掍欢杩愯鍦?DSH 鍐咃紝Node 鐗堟湰璺熼殢 DSH锛夛紱
- 瑙ｇ爜 `.project` / `.dvp` 闇€瑕?Python 3.9+ 鍦?`PATH` 閲岋紙鍙敤鏍囧噯搴擄紝鏃犻渶 pip 瀹夎锛夛紱
- 瑙ｇ爜 `.smart` / `.smartlib` 涓嶉渶瑕?Python銆?- 瑕佹眰 DSH >= 0.2.1-alpha.3锛涘疄娴?0.2.1-alpha.3銆?.2.2-rc.1锛屾洿楂樼増鏈湭楠岃瘉銆?
浠?GitHub 瀹夎锛?
```sh
dsh plugin --profile web add github:taoziliyouchong/dsh-plc-decode
```

瑁呭畬閲嶅惎 DSH銆傛湰鎻掍欢娌℃湁 npm 杩愯鏃朵緷璧栥€?
## 浣跨敤

### 宸ュ叿锛堟ā鍨嬭嚜鍔ㄨ皟鐢級

| 宸ュ叿 | 鐢ㄩ€?|
|---|---|
| `plc-decode` | 缁熶竴鍏ュ彛锛氭寜鏂囦欢澶磋瘑鍒洓鏍煎紡骞跺垎鍙戣В鐮侊紝鍙傛暟 `file` + 鍙€?`outDir` |
| `smart-pou-structure` | 鏌愬瓙绋嬪簭鐨勫唴閮ㄧ粨鏋勶細鎺ュ彛鍙傛暟锛圠 鍖哄湴鍧€ + 绫诲瀷锛夈€佺洅绾ф寚浠ら摼銆佽皟鐢ㄧ偣瀹炲弬 |
| `smart-lad` | 杩炵嚎杩樺師锛氭寜鍧椼€佹寜缃戠粶鎵撳嵃 LAD 鎸囦护搴忓垪锛圠D/A/O/AN/ON銆丒U/ED銆丩PS/LRD/LPP銆佺嚎鍦堛€佹瘮杈冦€佹寚浠ょ洅鍗犱綅锛?|
| `smart-ladder-elements` | 鍏冪礌绾ц/鍐欏垽瀹氾細鏌愬湴鍧€锛堝彲涓€鎵癸級鐨勬瘡涓惤鐐规槸瑙︾偣锛堣锛夎繕鏄啓 |
| `smart-net-trace` | 缃戠粶绾ц建杩癸細缁欏亸绉诲尯闂达紝鎸夐『搴忓垪鍑鸿Е鐐?/ 鍐欏厓浠?/ 鎸囦护鐩?/ 甯告暟 |
| `smart-box-pins` | 鐩掔骇寮曡剼琛細搴撹皟鐢ㄧ洅锛圡BUS_CTRL銆丮BUS_MSG銆乀ON銆丆TU銆丮OV_* 绛夛級鐨勩€屽紩鑴氬悕 = 瀹炲弬銆?|
| `smart-pin-dump` | 瀛楄妭绾у畾浣嶏細鏌愬湴鍧€鐨勫叏閮ㄥ嚭鐜颁綅缃紝鎴栨煇鍋忕Щ鍖洪棿鍐呯殑鎿嶄綔鏁拌褰?|
| `smart-var-usage` | 鍙橀噺浣跨敤浣撴锛氭煇鍦板潃鐨勫叏閮ㄥ紩鐢ㄧ偣銆佸叡鐢ㄥ瓧鑺傜殑鍏跺畠鍦板潃褰㈠紡銆佸啓鍏ョ偣鍒ゅ畾 |
| `smart-free-space` | 鍦板潃鍗犵敤涓庣┖闂叉锛氬姞鍔熻兘鍓嶉€夋柊鍦板潃锛堟湁绗﹀彿鍚嶇殑銆侀鐣欏潙閮戒笉鍔級 |
| `smart-conflict` | 鍦板潃鍐茬獊浣撴锛氶噸鍙犲啿绐侊紙鐪熷啿绐?/ 鐤戜技 / 浠呯櫥璁帮級+ 杩炵画绌洪棿琚垏纰?|
| `smart-diff-project` | SMART 鏂版棫宸ョ▼瀵规瘮锛氬潡娓呭崟銆佷富绋嬪簭璋冪敤閾俱€両-O 寮曠敤銆佺鍙疯〃宸紓 |
| `codesys-diff-project` | CoDeSys 鏂版棫宸ョ▼瀵规瘮锛歅OU 娓呭崟銆佺湡瀹為€昏緫鍙樺寲鍖烘銆佺┖鐧藉樊寮傘€佸瓧绗︿覆琛ㄣ€佸璞¤〃 |
| `hmi-decode` | 瑙︽懜灞忕粺涓€鍏ュ彛锛氭寜鏂囦欢璇嗗埆 `.hmismart` / `.fsprj` / `.nbp` / `.mcp` / `.emtp` / `.exob` 骞跺鐞?|
| `hmi-diff-project` | 鏂版棫 `.hmismart` 瀵规瘮锛氳捣濮嬬敾闈€佺敾闈㈣〃銆佺敾闈㈠悕銆侀厤濂楁枃浠?|
| `ebpro-decode` | 濞佺憾閫?EBpro锛氳缂栬瘧浜х墿 `.exob` 瑙ｇ爜鐢婚潰 / 鏂囧瓧瀵硅薄 / 鎶ヨ浜嬩欢 / 鏂囧瓧搴擄紙鍑?HMI瑙ｇ爜鎶ュ憡.md 涓?4 寮?tsv锛?|
| `ladder-auto` | 鑷姩鐢绘褰㈠浘锛氱洿鎺ヨ `.smart`锛屾寜鍧?缃戠粶鐢熸垚鐩掑紡鏂囧瓧姊舰鍥撅紙鍙寚瀹?`block` / `net`锛?|
| `ladder-dvp` | 鍙拌揪 `.dvp` 鐩存帴鍑虹洅寮忔枃瀛楁褰㈠浘锛堝彲鎸夎鍙疯寖鍥达級 |
| `ladder-from-stl` | 璇彞琛紙STL锛夆啋 鏂囧瓧姊舰鍥?+ 鏈烘璁茶В |
| `ladder-render` | 鎶婄綉缁滄弿杩帮紙spec锛夋覆鏌撴垚鍥哄畾鐗堝紡鐨勬枃瀛楁褰㈠浘 |

### 鏂滄潬鍛戒护锛堜汉鐩存帴鎵ц锛?
| 鍛戒护 | 鐢ㄩ€?|
|---|---|
| `/plc-decode <鏂囦欢> [杈撳嚭鐩綍]` | 缁熶竴瑙ｇ爜鍏ュ彛 |
| `/plc-archive` | 鏌ョ湅褰撳墠鐢熸晥鐨勮В鐮佸綊妗ｆ牴鐩綍銆侀粯璁よ惤鐐逛笌鏀归厤缃殑鏂规硶 |
| `/codesys-read <宸ョ▼>` | 瑙ｇ爜 `.project`锛圫T 婧愮爜 + 鎶ュ憡锛夋垨 `.dvp`锛堣В鐮佹姤鍛婏級 |
| `/dvp-read <宸ョ▼>` | 鍙拌揪 DVP 缁撴瀯涓庢寚浠よ〃鎶ュ憡 |
| `/smart-read <.smart/.smartlib> [杈撳嚭鐩綍]` | SMART 宸ョ▼ / 搴撹В鐮?|
| `/codesys-check <宸ョ▼>` | 瑙ｇ爜 `.project` 鍚庡仛绛変环缂栬瘧闈欐€佹牎楠岋紙缁撴瀯浣?/ 璋冪敤 / 鍦板潃鍞竴 / 鏈０鏄庣鍙凤級 |
| `/codesys-diff <鏃? <鏂?` | CoDeSys 鏂版棫瀵规瘮 |
| `/smart-diff <鏃? <鏂?` | SMART 鏂版棫瀵规瘮 |
| `/smart-free-space <.smart>` | 鍦板潃鍗犵敤涓庣┖闂叉 |
| `/smart-conflict <.smart>` | 鍦板潃鍐茬獊浣撴 |
| `/smart-ladder <.smart> [鍦板潃]` | 鍏冪礌绾ц/鍐欏垽瀹?|
| `/smart-lad <.smart> [鍧楀悕] [缃戠粶鍙穄` | 杩炵嚎杩樺師锛圠AD 鎸囦护搴忓垪锛?|
| `/hmi-decode <.hmismart / .fsprj / .nbp / .mcp / .emtp / .exob> [杈撳嚭鐩綍]` | 瑙︽懜灞忓伐绋嬭В鐮?|
| `/hmi-diff <鏃?.hmismart> <鏂?.hmismart>` | 瑙︽懜灞忔柊鏃у姣?|
| `/ladder on\|off\|status` | 姊舰鍥惧姛鑳藉紑鍏筹紙榛樿鍏抽棴锛屽紑鍚悗绔嬪嵆鐢熸晥锛?|
| `/ladder-auto <.smart> [鍧楀悕] [缃戠粶鍙穄 [杈撳嚭.txt]` | `.smart` 鑷姩鍑烘褰㈠浘 |
| `/ladder-dvp <.dvp> [璧疯] [姝㈣] [杈撳嚭.txt]` | `.dvp` 鑷姩鍑烘褰㈠浘 |
| `/ladder-stl <璇彞琛?txt> [杈撳嚭.txt]` | 璇彞琛ㄦ垚鍥?+ 璁茶В |
| `/ladder-spec <spec.json> [杈撳嚭.txt]` | 鎸?spec 娓叉煋鏂囧瓧姊舰鍥?|
| `/plc-calibrate <鏍煎紡> <瀛楄妭鎴?cmd:XX> <鍚嶅瓧> [澶囨敞]` | 鎶婅В涓嶅嚭鐨勫瓧鑺?鍔熻兘鐮佽杩涙牎鍑嗚〃锛涗互鍚庡悓鏍峰瓧鑺傜洿鎺ュ嚭鍚嶅瓧 |

## 杈撳嚭浣嶇疆

榛樿鍐欏埌**宸ヤ綔鍖?*鐨?`瑙ｇ爜褰掓。/<宸ョ▼鎵€鍦ㄦ枃浠跺す鍚?/`锛堢敤鏂囦欢澶瑰悕鑰屼笉鏄伐绋嬫枃浠跺悕锛岄伩鍏嶄笉鍚屾枃浠跺す閲岀殑鍚屽悕宸ョ▼浜掔浉瑕嗙洊锛涘悓涓€鏂囦欢澶归噷鏈夊涓伐绋嬫枃浠舵椂鐢?`鏂囦欢澶瑰悕_宸ョ▼鍚峘锛夈€備篃鍙互鍦ㄥ伐鍏峰弬鏁伴噷鐢?`outDir` 鎸囧畾銆?
| 鏍煎紡 | 涓昏浜х墿 |
|---|---|
| `.project` | `00-绱㈠紩.md`锛堝厛璇昏繖浠斤級銆乣pous/<POU>.txt`锛圫T 婧愮爜锛夈€乣宸ョ▼鍐呭鎶ュ憡.md`銆乣鍏ㄩ儴瀛楃涓?txt`銆乣瀵硅薄琛?md`銆乣椤圭洰鏍?md` |
| `.dvp` | `00-绱㈠紩.md`銆乣瑙ｇ爜鎶ュ憡.md`锛堢粨鏋?/ 娈佃惤娉ㄩ噴 / 璁惧娉ㄩ噴 / 鎸囦护琛級銆佸彲閫?`绋嬪簭瑙ｈ.md` |
| `.smart` / `.smartlib` | `00-鐩綍.md`锛堝厛璇昏繖浠斤級銆乣瑙ｇ爜鎶ュ憡.md`銆乣绋嬪簭.lad`銆乣鍏冪礌璁板綍.tsv`銆乣绗﹀彿鍦板潃.tsv`銆乣鍒嗘瀽.md`銆乣璁板綍.json`銆乣瀛楃涓插叏褰?txt` |
| `.hmismart` | `10-鐢婚潰.tsv`銆乣11-鍏冧欢.tsv`銆乣12-鏂囨湰.tsv`銆乣13-璁惧.tsv`銆乣20-鍙橀噺.data.tsv`銆乣21-鎺т欢.data.tsv`銆乣23-鎺т欢缁戝畾.data.tsv`銆乣24-绫诲瀷琛?tsv` |
| `.fsprj` | `鐢婚潰.tsv`銆乣鎺т欢.tsv`銆乣鎺т欢鍦板潃.tsv`銆乣鍙橀噺.tsv` |
| `.nbp` / `.mcp` | `瑙ｇ爜鎶ュ憡.md` + 鐢婚潰/鎺т欢锛堟垨鍙橀噺/鎶ヨ/绛栫暐锛塉SON |
| `.emtp` / `.exob` | `HMI瑙ｇ爜/HMI瑙ｇ爜鎶ュ憡.md` + `00-鏍煎紡璇存槑.md` / `10-鐢婚潰.tsv` / `11-鏂囧瓧瀵硅薄.tsv` / `12-鎶ヨ浜嬩欢.tsv` / `13-鏂囧瓧搴?tsv` / `08-缁熻.json` |

### 姊舰鍥撅紙榛樿鍏抽棴锛?
姊舰鍥惧伐鍏烽粯璁や笉寮€鍚紝閬垮厤姣忔瑙ｇ爜閮藉涓€鎵瑰伐鍏蜂笌鎻愮ず锛?
- 寮€锛歚/ladder on`锛堢珛鍗崇敓鏁堬紝涓嶇敤閲嶅惎锛夛紱鍏筹細`/ladder off`锛涚湅鐘舵€侊細`/ladder status`
- 涔熷彲浠ュ湪 profile 鐨?`cordis.patch.yml` 閲岀粰鏈彃浠惰鍐?`config: { ladder: true }` 浣滀负鍒濆鐘舵€?- 鍏抽棴鏃惰皟鐢ㄦ褰㈠浘宸ュ叿鍙洖涓€琛屽紑鍚彁绀猴紱瑙ｇ爜浜х墿鐓у父
- 鍓嶄笁娆¤В鐮佷細鍦ㄧ粨鏋滄湯灏炬彁绀恒€岃繖涓伐绋嬪彲浠ュ嚭姊舰鍥俱€嶏紙绗?1/3銆?/3銆?/3 娆★級锛屼箣鍚庝笉鍐嶆彁绀猴紱寮€鍏充笌鎻愮ず璁℃暟璁板湪 `$DSH_HOME/ladder-state.json`

### 鏀瑰綊妗ｅ湴鍧€锛堜笉鐢ㄦ敼浠ｇ爜锛?
鍦?DSH profile 鐨?`cordis.patch.yml`锛坄$DSH_HOME/profiles/<profile>/cordis.patch.yml`锛夋湯灏剧粰鏈彃浠堕偅涓€琛屽姞 config锛堝彧鍐?`archiveDir`锛氬綊妗ｆ牴鐩綍锛夛細


`archiveDir` 鏄綊妗?*鏍圭洰褰?*锛氱浉瀵硅矾寰勬寜褰撳墠浼氳瘽宸ヤ綔鍖鸿В鏋愶紝缁濆璺緞鍘熸牱浣跨敤锛涢粯璁?`瑙ｇ爜褰掓。`銆傛敼瀹岄噸鍚?dsh 鐢熸晥锛宍/plc-archive` 鍙殢鏃舵煡鐪嬪綋鍓嶇敓鏁堝€硷紱鍙兂鏀逛竴娆″氨鍦ㄨВ鐮佹椂浼?`outDir`銆?
`.smart` 鐨?`璁板綍.json` 鍚屾椂鏄悇鍒嗘瀽宸ュ叿锛堝湴鍧€鍗犵敤銆佸彉閲忎娇鐢ㄧ瓑锛夌殑杈撳叆锛屼篃鏄瘑鍒€屽凡瑙ｇ爜鐩綍銆嶇殑鍑嵁锛涜В鐮佹姤鍛婂ご閮ㄥ甫**婧愭枃浠舵寚绾?*锛堟枃浠跺ぇ灏?+ 淇敼鏃堕棿锛夛紝宸ョ▼鎹㈢増鏈悗鍏堟牳瀵规寚绾瑰啀鐢ㄦ棫鎶ュ憡銆?
## 宸茬煡杈圭晫

- 瑙︽懜灞忓伐绋嬶細`.hmismart` 閲屽彧鏈夋ā鏉块鏋讹紝鐪熷疄鐢婚潰涓庢帶浠跺湪鏃佺郴 `{{GUID}}.data`锛圗S2RT 搴忓垪鍖栨祦锛夛紝鍙橀噺鍚嶄笌鎺т欢鍚嶈兘瑙ｏ紝鎺т欢鍒板彉閲忕殑寮曠敤鍙В鍑哄悓娈靛叡鐜颁笌 UUID 鍛戒腑閭ｉ儴鍒嗭紝鍏朵綑鏍囥€屾湭瑙ｅ嚭銆嶏紱绻佹槗宸ョ▼鑻ユ病寤哄彉閲忥紝鎺т欢鍦板潃鍙湪 `Bin\fshmi.bin` 鐨勫姩浣滆〃閲岋紱鏄嗕粦閫氭€佸伐绋嬮渶鏈満鏈?`.mcp` 鏍锋湰鎵嶈兘楠岃瘉銆?- 濞佺憾閫?EasyBuilder Pro锛歚.emtp` 鏈綋鍘嬬缉+鍔犲瘑锛岃涓嶅嚭缁撴瀯锛屽彧鑳藉彇鍚屽伐绋嬬紪璇戜骇鐗?`.exob`锛涜〃鍙嶆槧**缂栬瘧閭ｄ竴鍒?*鐨勫伐绋嬶紙宸ョ▼鏀硅繃娌￠噸鏂扮紪璇戝氨鍏堢紪璇戝啀璺戯級銆傜紪璇戜骇鐗╅噷鍙湁婧愯瑷€銆佹病鏈夎瘧鏂囥€傜敾闈㈠綊灞炴寜瀵硅薄娴佸垎娈垫帹瀹氾紝琛ㄩ噷鐨?x/y/w/h 鏄瓧涓插妗嗗害閲忎笉鏄敾闈㈠潗鏍囥€?- 搴撳潡璋冪敤鍖猴紙濡?MBUS_MSG 鐨?Slave / RW / Addr / Count / DataPtr锛夌殑寮曡剼绾у疄鍙傝В涓嶅嚭锛屽伐鍏蜂細鏄庣‘璇存槑锛屼笉鐚溿€?- 鍔犲瘑鎴栫壒娈婂帇缂╃殑宸ョ▼鍙兘瑙ｄ笉鍑猴紱瑙ｇ爜鍣ㄤ細鎶ラ敊鑰屼笉鏄粰鍑哄崐鐪熺粨鏋溿€?- `.smart` 鐨勪覆/骞惰仈鎷撴墤鐢辨寚浠よ褰曡繕鍘燂紝宸茬敤瀹樻柟瀵煎嚭鐨?STL 閫愮綉缁滃洖褰掗獙璇侊紱搴撹皟鐢ㄥ尯锛堟棤鏍囧噯鐩掑ご锛変笉鍦ㄨ鐩栬寖鍥村唴銆?- 鎸囦护鍚嶅甫 `?`锛堝 `?DRVI`锛夋槸鎺ㄦ柇鍚嶏紝鎶ュ憡鏈熬鏈夋帹鏂鐓ц〃锛沗??xx` 鏄湭瀹氬悕锛屼繚鎸佸師鏍枫€?
## 寮€鍙戜笌鑷

```sh
npm run check                 # 璇硶妫€鏌?npm run smoke                 # 瑁呰浇鎻掍欢 + 鏍稿娉ㄥ唽闈紙宸ュ叿 19 涓?/ 鍛戒护 20 涓級
npm run smoke -- <宸ョ▼鏂囦欢>    # 棰濆瀵逛竴涓湡瀹炲伐绋嬭窇绔埌绔В鐮侊紝鏍稿浜х墿钀界洏
npm pack --dry-run            # 鐪嬪寘閲屽唴瀹癸紙node_modules銆乸ublish/ 涓嶅簲杩涘寘锛?```

## 鐩綍缁撴瀯

```
index.js                    鎻掍欢鍏ュ彛锛氬伐鍏蜂笌鍛戒护娉ㄥ唽銆佸洓鏍煎紡鍒嗗彂銆丼MART 瑙ｇ爜鍣?hmi.js                      瑙︽懜灞忚В鐮佹ā鍧楋紙宸ュ叿/鍛戒护/鎶€鑳芥敞鍐岋紝鐢?index.js 璋冪敤锛?ladder.js                   姊舰鍥炬覆鏌?鑷姩鎴愬浘妯″潡锛堥粯璁ゅ叧闂紝/ladder on 鎵撳紑锛岀敱 index.js 璋冪敤锛?assets/decode-pack.mjs      瑙ｇ爜浜х墿钀界洏锛堢储寮?鐩綍/琛ㄦ牸/璁板綍锛?assets/smart-lad.mjs        杩炵嚎杩樺師鑴氭湰锛堢敱 smart-lad 宸ュ叿璋冪敤锛?assets/smart-net-trace.mjs  缃戠粶杞ㄨ抗鑴氭湰锛堢敱 smart-net-trace 宸ュ叿璋冪敤锛?assets/codesys-tools/       CoDeSys / DVP 瑙ｇ爜 Python 鑴氭湰锛堝彧鐢ㄦ爣鍑嗗簱锛?assets/hmismart-decode.mjs  瑗块棬瀛?.hmismart 瑙ｇ爜鍣紙缁撴瀯琛?+ .data 鍚嶅瓧/缁戝畾/绫诲瀷琛級
assets/hmismart-report.mjs  .hmismart 浜鸿鎶ュ憡锛堢敾闈?鍙橀噺/杩炴帴/鍏冧欢鍒嗙被锛?assets/hmismart-diff.mjs    .hmismart 鏂版棫瀵规瘮
assets/fstudio-tables.py    绻佹槗鐢婚潰 / 鎺т欢 / 鎺т欢鍦板潃琛?assets/fstudio_i18n.py      绻佹槗鍏冧欢鏂囨湰鎵弿锛堟寜璇鍒嗘Ы锛?assets/hmi-decode-workflow.md  瑙︽懜灞忚鍙栧伐浣滄祦锛堟妧鑳芥鏂囷級
assets/ladder-workflow.md     梯形图技能（排版规范、自动成图、交付前自检）
assets/nb-decode.mjs        娆у榫?NB-Designer 瑙ｇ爜鍣?assets/mcgs-decode.mjs      鏄嗕粦閫氭€?MCGS / LSTP 瑙ｇ爜鍣?assets/ebpro-decode.mjs     濞佺憾閫?EBpro 瑙ｇ爜锛堣 .exob锛氱敾闈?/ 鏂囧瓧瀵硅薄 / 鎶ヨ浜嬩欢 / 鏂囧瓧搴擄級
assets/ladder-render.mjs    鏂囧瓧姊舰鍥炬覆鏌撳櫒锛堝浐瀹氱増寮忥紝鐢?ladder-render 璋冪敤锛?assets/stl-to-ladder.mjs    璇彞琛ㄨ浆姊舰鍥撅紙鐢?ladder-from-stl 璋冪敤锛?assets/smart-ladder-auto.mjs .smart 鑷姩鎴愬浘锛堢敱 ladder-auto 璋冪敤锛?assets/dvp-ladder.mjs       .dvp 鑷姩鎴愬浘锛堢敱 ladder-dvp 璋冪敤锛?scripts/smoke.mjs           鍐掔儫娴嬭瘯
```

## 鍙嶉

鎻掍欢鏈夐棶棰橈紝鎸夎繖涓『搴忥細

1. 寮€ Issue锛歨ttps://github.com/taoziliyouchong/dsh-plc-decode/issues 鈥斺€?鑳界暀鐥曘€佽兘鎼滃巻鍙诧紝鍒汉涔熷彲鑳藉凡缁忛亣杩囷紱
2. 鎬ョ潃闂垨涓嶆兂寮€ Issue锛孮Q 鍙凤細**2171960697**锛堝姞濂藉弸璇锋敞鏄庤鐨勬槸鍝釜鎻掍欢锛夈€?
鍙嶉鏃跺甫涓婏細DSH 鐗堟湰銆佹彃浠剁増鏈€佹姤閿欏師鏂囥€佹埅鍥俱€傚皯涓€鏍峰鍗婅鍐嶉棶涓€杞€?
## 璁稿彲

MIT
