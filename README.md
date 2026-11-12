# bimpack — BIM GLB 处理工具链

把「Revit → 3ds Max → GLB → 网页」这条路上踩过的坑，固化成一个可复用的流水线。
**换楼层只需要换输入文件名**，其余不用改代码。

已经在 31F（`117_T_31F_A&S&MEP.glb`）上跑通：208.21 MB → 63.20 MB → 线上传输 **5.14 MB**，19 项校验全绿。

---

## 怎么运行（三种方式，任选其一）

**方式 A：双击运行（Windows，最省事）**

在 `bimpack` 文件夹里双击 **`start.cmd`**。
首次会自动装依赖（约 30 秒），然后自动打开浏览器。关掉那个黑窗口就停止服务。

**方式 B：命令行**

```bash
cd bimpack
npm install      # 只需第一次
npm start        # 等价于 node start.mjs
```

**方式 C：只要服务，不要自动开浏览器**

```bash
cd bimpack
node src/cli.mjs serve          # 或 set NO_OPEN=1 & npm start
PORT=8081 node src/cli.mjs serve   # 换端口
```

服务起来后会打印地址，通常是 **http://localhost:8080**：

```
  BIM 处理台  http://localhost:8080
  已有楼层    1 个（打开页面后可选择，不再自动加载）
  上传目录    ...\bimpack\inbox
```

> 8080 被占用时会自动顺延到 8081、8082…并以实际地址为准（`start.mjs` 会打印出来）。
> 用 `start.cmd` / `npm start` 时会自动打开浏览器；直接 `serve` 不会。
>
> 在黑窗口里按 Ctrl+C 时，cmd 可能追问一句「终止批处理操作吗(Y/N)?」—— 按 `Y` 即可。
> 想省事就直接双击 `stop.cmd`，或干脆关掉那个黑窗口。

### 双击报错「'd' 不是内部或外部命令」怎么办

**已经不会再出现了**，但记一下原因，以后改这两个文件时别踩回去：

`start.cmd` / `stop.cmd` **必须是纯 ASCII 内容 + CRLF 行尾**。

中文 Windows 的 cmd 按代码页 936（GBK）读取批处理文件。如果文件存成 UTF-8 且里面有中文，
一个汉字的三字节序列会被 GBK 拆成「一个汉字 + 一个尾字节」，而尾字节恰好可能是
`&`、`|`、`>`、`<` 这类命令分隔符 —— 于是 `cd /d "%~dp0"` 被切成 `cd /` 和 `d`，
`https://nodejs.org/` 被切成 `?https:` 加后面一截，报出来就是：

```
'd' 不是内部或外部命令
'e!' 不是内部或外部命令
'根' 不是内部或外部命令
'?https:' 不是内部或外部命令
```

所以现在这两个 `.cmd` 里**一个中文字符都没有**，所有中文提示都由 `node start.mjs` / `node stop.mjs`
打印（Node 按 UTF-8 输出，配合开头的 `chcp 65001` 显示正常）。

改完自检一行：

```bash
python -c "b=open('start.cmd','rb').read(); print('non-ascii', sum(1 for x in b if x>127), '| CRLF', b.count(b'
'))"
# 期望：non-ascii 0 | CRLF > 0
```

### 怎么关闭 / 端口怎么释放

**双击 `stop.cmd`**（等价 `npm stop`）。它会读 `.server.json` 里的 PID 把服务连同子进程一起结束，
再兜底扫一遍残留的 node 进程，最后删掉锁文件。

也可以：

```bash
npm stop                              # 停止并清理残留
node start.mjs --restart              # 一键重启（先停再起）
netstat -ano | findstr :8080          # 万一是别的程序占了端口
taskkill /PID <上面查到的号> /F
```

**重复双击不会再占新端口。** 服务启动后会写一个 `.server.json` 记录 PID 和端口；
再次双击 `start.cmd` 时，启动器发现它已经在跑，只会**打开浏览器**然后退出，不会再起一个新实例。

> 之前"每开一次就多占一个端口"，是因为关窗口时子进程没被带走，残留实例继续占着 8080，
> 新实例只能顺延到 8081。现在有单实例锁 + `stop.cmd` 兜底扫描，不会再累积。

---

## 用法一：上传即处理（不用敲命令）

```bash
cd bimpack
npm i                     # 只需一次
node src/cli.mjs serve    # 打开 http://localhost:8080
```

浏览器里：

0. 打开就是上传页 —— **不会自动加载任何模型**，必须先传或从列表里选一层
1. 把 `.glb` **拖进方框**（或点一下选文件）
2. 上传进度条走完 → 自动开始处理，日志实时滚动
3. 跑完点「查看模型 →」，直接在 3D 里点构件看 BIM 属性

页面下方列出所有已处理的楼层，点「查看」随时切回去。压缩档位可选 `自动 / 高保真 / 均衡 / 小体积`，
默认「自动」（源文件已 Draco 时自动用 16bit，否则 14bit）。

**楼层列表的行为**（这三条是踩过坑才补的）：

- 列表**每 4 秒自动刷新**，切回标签页/窗口时立刻刷新一次；也有手动「刷新」按钮。
  `/api/*` 响应一律带 `Cache-Control: no-store`，不会被浏览器缓存成旧快照。
- 处理中断或校验未通过的目录会显示为 **「未完成 · 原因」** 并且**点不进预览**，
  不会像以前那样以一堆「—」混在列表里让人看不懂。
- 「未完成」条目右侧有**删除**按钮（只删 `out/` 下的产物，不动 `inbox/` 里的原始上传）。

处理在服务器端跑，关掉浏览器也不影响；产物落在 `out/<楼层名>/`。

## 用法二：命令行批处理

```bash
# 新楼层：一条命令走完全流程（约 1~2 分钟）
node src/cli.mjs build "D:/导出/117_T_32F_A&S&MEP.glb"

# 看效果
node src/cli.mjs serve
# → http://localhost:8080       处理台（上传 + 历史）
# → /view?run=<楼层>             直接看某一层
# → /view?raw=1                  对照组（12209 draw call 原样加载）
```

`build` 会做六件事，中间任何一步出问题都会明确报出来：

```
▶ build  117_T_31F_A&S&MEP.glb  208.21 MB
  ✓ 体检          节点 12247 / 图元 12209 / 材质组 29
  ✓ 版本修正      2.1 → 2.0
  ✓ Draco 编码     208.21 MB → 63.20 MB  (−69.6%, pos 16bit, 13.8 s)
  ✓ 属性校验      19 项 · 全部通过  · 变换位移 1.5e-5 单位
  ✓ 几何保真      最大偏差 0.199 单位 (模型跨度 59357) · 面积差 0.0003%
  ✓ 预压缩        br 5.14 MB · gz 11.18 MB
```

产物落在 `out/<楼层名>/`：`*.glb`、`*.glb.br`、`*.glb.gz`、`manifest.json`、`report.md`。

---

## 命令

| 命令 | 用途 |
|---|---|
| `node src/cli.mjs inspect <file.glb>` | 体检：版本、扩展、规模、材质分组、属性量、风险项。只读 JSON，秒级 |
| `node src/cli.mjs build <file.glb>` | 全流程（见上），产出报告与 viewer 可用的 manifest |
| `node src/cli.mjs verify <a.glb> <b.glb>` | 只比两个文件，`--geo` 追加解码级几何比对 |
| `node src/cli.mjs serve` | 起 viewer，自动选中 `out/` 下最新的楼层 |

`build` 常用选项：

| 选项 | 说明 |
|---|---|
| `--preset high\|balance\|small` | 量化位深预设。默认 `balance`(14bit)；**源文件已 Draco 时自动升到 `high`(16bit)** |
| `--out <dir>` | 输出根目录，默认 `./out` |
| `--name <slug>` | 自定义输出目录名（默认由文件名净化，`&` 之类会变 `-`） |
| `--no-geo` | 跳过解码级几何比对，省 10 s |
| `--no-gzip` | 只出 `.br`，不出 `.gz` |

### 上传页背后的接口（想接自己的系统时用）

| 接口 | 说明 |
|---|---|
| `PUT /api/upload?name=<文件名>` | 请求体就是文件本身（流式落盘到 `inbox/`），返回 `{file,size}` |
| `POST /api/build` | 体 `{file, preset:"auto|high|balance|small", geo:true}`，返回 `{id}` |
| `GET /api/job/<id>` | `{status:"running|done|failed", run, lines[], ms}`，前端每 600ms 轮询 |
| `GET /api/runs` | 已处理楼层列表（含统计、`status: ok\|incomplete`、未完成原因） |
| `DELETE /api/runs/<run>` | 删除某个楼层的产物目录（不影响 inbox 原始文件） |

上传不用 multipart，直接把 file 当 body PUT 上去，简单且能流式写盘；进度用 XHR 的 `upload.onprogress`。

---

## 配置：`bim.config.json`

```json
{
  "outDir": "out",
  "preset": "balance",
  "geoSamples": 350,
  "transformTolerance": 0.01,
  "precompress": { "brotli": { "quality": 11, "lgwin": 24 }, "gzip": true },
  "viewer": { "dracoDecoderPath": "https://www.gstatic.com/draco/..." }
}
```

| 键 | 含义 |
|---|---|
| `preset` | 默认位深档，可被 `--preset` 覆盖 |
| `geoSamples` | 几何比对抽样图元数，越大越慢越准（350 约 9 s） |
| `transformTolerance` | 变换等价的角点位移容差，单位同模型。mm 模型 0.01 = 10 µm |
| `precompress` | 传输层预压缩参数 |

---

## 流水线每一步在解决什么

### 1. 版本修正（`src/glb.mjs`）
3ds Max 的 Khronos glTF 导出器会写 `asset.version: "2.1"`。**这不是合法 glTF 值**（规范只允许 `2.0`），
glTF-Transform / three.GLTFLoader 会直接抛 `Unsupported glTF version` 拒绝加载。
工具在进解析器之前按字节改写 JSON chunk，二进制不动。

> 所以"模型打不开"十有八九不是模型坏了，是这个字段。

### 2. Draco 重编码（`src/compress.mjs`）
glTF-Transform + draco3dgltf，**只做几何重编码**，不做 weld / simplify / prune / join ——
任何拓扑或图元结构改动都会破坏 BIM 构件一一对应关系。

位深选择上有个判断：源文件若已含 Draco，再压就是**二次编码**（不可逆的二代有损），
所以工具会自动把 `balance(14bit)` 升到 `high(16bit)`：16bit 对本模型（单件最大 59357 单位）误差上限 0.91 mm，
实测最大偏差 0.199 单位，不值得为省 5% 体积冒风险。

### 3. 属性校验（`src/verify.mjs`）
19 项的闸门，任何一项挂红都不该交付：

- 节点数 / 网格数 / 图元数 / 材质数
- **节点名称逐项一致、父子层级一致**（构件对得上号）
- **节点 extras 逐条指纹一致**（BIM 属性零丢失，本模型 795,727 条）
- 变换等价、材质数值等价、每图元材质绑定、三角面数、扩展列表

两个判据上的工程决定：

- **材质用数值比，不用 JSON 文本比**：`1` 和 `1.0` 是不同的字符串，但是同一个数。
- **变换用"角点位移"比，不用逐元素比矩阵**：逐元素在 157 米量级的平移上会把 float32 四元数
  往返噪声（1.5e-5 单位）误判成失败；角点位移能真实反映"构件会不会错位"，
  也能抓住剪切（shear）这种 TRS 表达不出来的矩阵。

### 4. 几何保真（`src/verify.mjs: compareGeometry`）
解码两侧、抽样图元逐顶点算最近邻距离，报最大/平均偏差与三角面总面积差。这是唯一能证明
"看起来没变"的硬指标，默认开启（`--no-geo` 可关）。

### 5. 传输层预压缩（`src/precompress.mjs`）
brotli q11 + gzip 兜底。**必须构建期做**：60 MB 压一次 47 s，放请求期会拖死服务器。
实测这个模型：63.20 MB → br **5.14 MB**（−91.9%）/ gz 11.18 MB（−82.3%）。

### 6. viewer（`viewer/`）
读 `manifest.json` 决定画什么、怎么画，所以换楼层不用改前端：

- `viewer/bim-batch.js` —— 把上万独立 Mesh 收成按材质分组的 `BatchedMesh`
  （12209 draw call → 29），保留逐构件剔除 / 显隐 / 拾取
- `viewer/index.html` —— 点击构件查 BIM 属性，HUD 实时显示 draw call 与 FPS
- `viewer/server.cjs` —— 本地服务器 + **传输层 brotli 的参考实现**（含 `Vary: Accept-Encoding`、
  `model/gltf-binary`、`application/wasm` 三处易错点）

---

## 目录

```
bimpack/
├── src/
│   ├── cli.mjs          命令分发与编排
│   ├── glb.mjs          GLB 字节级读写 / 版本修正
│   ├── inspect.mjs      体检
│   ├── compress.mjs     Draco 编码（含 high/balance/small 预设）
│   ├── verify.mjs       JSON 层 + 几何层比对
│   ├── precompress.mjs  .br / .gz
│   └── report.mjs       markdown 报告
├── viewer/              三个文件：批处理模块 / 页面 / 服务器
├── test/batch.test.mjs  无头单测（18 项，不需 WebGL）
├── out/<楼层>/           每层一个目录，互不覆盖
└── bim.config.json
```

---

## 每次新楼层的标准动作

1. `node src/cli.mjs inspect <新文件>` —— 先看体检，确认版本是不是又写成 `2.1`、材质分组多少、有没有贴图
2. `node src/cli.mjs build <新文件>` —— 跑全流程
3. 看 `out/<楼层>/report.md` 的第三、四节：属性校验是否全 PASS、几何偏差是否可接受
4. `node src/cli.mjs serve` —— 浏览器里看 FPS 和拾取是否正常
5. 上线：把 `out/<楼层>/` 整个目录传到服务器，按 `report.md` 里的 nginx 配置片段发 `.br`

> **有贴图的楼层**（精装、幕墙）：体检会提示 `存在贴图但只有 N 个图元带 UV`。
> 此时 `manifest.hasTextures = true`，viewer 会自动保留 uv 并给缺失的补空属性，
> 不需要改代码；但**别**手动加 `--preset small`，UV 精度会掉。

---

## 已知限制

- **必须源文件几何是三角形**：`mode: 4`。点线、条带会被跳过（体检里 `skipped` 会显示）。
- **必须源文件带 `POSITION`**：没有的话无法批处理。
- 变换的 `matrix` 会被改写成 `translation/rotation/scale`（glTF 规范等价写法），
  角点位移在容差内即通过；若某天出现**真含剪切**的矩阵，校验会报 FAIL 并在报告里点名节点。
- 顶点数会比源文件多 2~3%：Draco 对非流形边会拆点（位置完全相同），不影响外形。
- viewer 的 three.js 走 CDN importmap，只适合本地看效果；生成环境请换成自己的打包产物，
  并把 Draco 解码器自托管（`viewer/index.html` 里的 `dracoDecoderPath`）。

---

## 与旧脚本的关系

`glb_draco/`、`threejs_bim/` 是这套东西的前身（一次性 Python/JS 脚本）。
功能已被 `bimpack/` 全部覆盖且做了通用化，可以删掉；留着也不影响运行。
