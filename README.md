# bimpack — BIM GLB 预览与压缩

## 一、项目简介与使用方法

### 简介

bimpack 处理 BIM 软件（Revit / 3ds Max 等）导出的 `.glb` 模型，一套代码两种用法：

- **`web/`**：纯前端单页应用。把模型拖进浏览器即可预览、查看 BIM 属性、按属性合成
  「专业 → 系统 → 类别 → 类型 → 构件」规范层级树；需要交付时再压缩，通过校验后下载。
  文件不上传、不需要服务端。
- **`src/`**：同一套逻辑的命令行版。批量做 Draco 压缩、属性校验、预压缩（`.br` / `.gz`）
  并生成交付报告，适合成批出包或机器跑不动浏览器时使用。

### 环境要求

- Node.js 18 以上（实测 22）
- 支持 WebGL2 的现代浏览器（Chrome / Edge 等）；前端测试需要本机已装 Chrome

### 安装

```bash
git clone git@github.com:Vickiiris/bimpack.git
cd bimpack

npm install            # 命令行依赖
npm install --prefix web   # 前端依赖（vite / three / gltf-transform 等）
```

### 配置

| 文件 | 作用 |
|---|---|
| `bim.config.json` | 命令行默认配置：输出目录 `outDir`、量化预设 `preset`、几何抽样数 `geoSamples`、`.br` / `.gz` 参数 |
| `wrangler.toml` | 部署到 Cloudflare Pages 时声明静态产物目录（`web/dist`） |

模型放 `inbox/`，产物落 `out/`，两者都在 `.gitignore` 里，不随代码提交。

### 运行：前端（日常使用）

```bash
npm run dev            # 等价于 cd web && npm run dev → http://localhost:5173
```

打开页面即拖放区，不自动加载模型。拖入 `.glb` 后：

- **直接查看**：只修文件头里非法的 `asset.version`，几何不动，秒开。
- **压缩处理**：在浏览器内重编码几何，跑完十几项属性比对后才放开「下载」。

可继续在根目录构建静态站点：

```bash
npm run build          # → web/dist（相对路径，可放任意子目录）
npm run preview:web    # 本地预览构建产物
```

> `web/dist` 是纯静态文件，但**不能直接双击 `index.html`**：ES module 与 wasm 在 `file://` 下会被同源策略拦住，必须经由静态服务器访问。

### 运行：命令行（批量处理）

```bash
node src/cli.mjs inspect <file.glb>        # 体检：节点 / 图元 / 材质 / 属性 / 每顶点字节
node src/cli.mjs build   <file.glb>        # 全流程：修版本 → Draco → 校验 → 预压缩 → 报告
node src/cli.mjs verify  <a.glb> <b.glb>   # 只比两个文件（属性 + 可选几何）
```

`build` 常用选项：

| 选项 | 说明 |
|---|---|
| `--preset high\|balance\|small` | 量化位深（默认 `balance`；源文件已是 Draco 时自动升为 `high`） |
| `--out <dir>` / `--name <slug>` | 输出根目录（默认 `out/`）与输出目录名 |
| `--no-geo` / `--no-gzip` | 跳过解码级几何比对 / 只出 `.br` 不出 `.gz` |

产物目录内含 `report.md`、`manifest.json` 与预压缩文件。大模型（数百 MB）会自动用子进程放大堆内存，无需手动加参数。

## 二、目录结构说明

```
bimpack/
├── src/          命令行工具链（inspect / build / verify）
├── scripts/      部署用的根构建脚本
├── test/         命令行侧测试与样例生成
├── web/          纯前端应用（主入口）
├── inbox/        待处理模型（不入库）
├── out/          命令行产物（不入库）
├── bim.config.json
├── wrangler.toml
└── package.json
```

### 根目录

| 路径 | 用途 |
|---|---|
| `README.md` | 项目说明（本文件） |
| `package.json` | 根包：npm 脚本、`bimpack` 命令入口、命令行依赖 |
| `package-lock.json` | 依赖版本锁定 |
| `bim.config.json` | 命令行默认参数（输出目录、量化预设、预压缩） |
| `wrangler.toml` | Cloudflare Pages 配置，仅声明静态产物目录 |
| `.gitignore` | 忽略依赖、模型、产物与测试截图 |
| `inbox/` | 手工投放待处理 `.glb` 的目录 |
| `out/` | `build` 的输出根目录，每个模型一个子目录 |
| `src/` | 命令行实现，见下 |
| `scripts/` | 构建脚本，见下 |
| `test/` | 命令行侧测试，见下 |
| `web/` | 前端应用，见下 |

### `src/` — 命令行

| 文件 | 用途 |
|---|---|
| `cli.mjs` | 命令入口，分发 `inspect` / `build` / `verify`，按需放大堆内存 |
| `glb.mjs` | GLB 容器的字节级读写，含非法 `asset.version`（`2.1`）修正 |
| `inspect.mjs` | 体检：只读 JSON 块，统计节点、图元、材质、属性与每顶点字节数 |
| `compress.mjs` | 用 Draco 重编码几何（只重编码，不做 weld / simplify / prune / join） |
| `verify.mjs` | 交付闸门：JSON 全量比对 + 可选的解码级几何比对 |
| `precompress.mjs` | 生成 `.br` / `.gz` 传输层压缩副本 |
| `report.mjs` | 把一次 build 的全过程渲染成 `report.md` |

### `scripts/` 与 `test/` — 构建与测试

| 文件 | 用途 |
|---|---|
| `scripts/build-web.mjs` | 部署平台在根目录执行 `npm run build` 时调用：装 `web/` 依赖并构建，跳过 Playwright 浏览器下载 |
| `test/batch.test.mjs` | 无头单元测试：批处理分组、变换烘焙、拾取、显隐与高亮 |
| `test/make-fixture.mjs` | 生成一个带典型缺陷的极小样例 GLB（版本号 2.1、未压缩、含 `null` 字段） |
| `test/fixture.glb` | 上述脚本的产物，测试用（不入库） |

### `web/` — 前端应用

| 路径 | 用途 |
|---|---|
| `index.html` | 单页骨架：顶栏、拖放区、层级树、属性面板、下载按钮 |
| `package.json` / `package-lock.json` | 前端依赖与 `dev` / `build` / `preview` 脚本 |
| `vite.config.js` | `base: './'`、开发端口 5173、Draco 解码器单独分包 |
| `README.md` | 前端详细说明：交互约定、层级树合成规则、实测数据、已知限制 |
| `public/draco/draco_decoder.js` | Draco asm.js 解码器，只用于读入已压缩的源文件 |
| `src/` | 应用源码，见下 |
| `test/` | 浏览器端与分组规则的测试，见下 |
| `dist/` | 构建产物（不入库） |

### `web/src/` — 应用源码

| 文件 | 用途 |
|---|---|
| `main.js` | 页面编排：拖入 → 体检 → 压缩 → 渲染 → 树/属性联动 → 下载 |
| `style.css` | 全部界面样式，含各专业对应的色点 |

### `web/src/core/` — 处理流水线

| 文件 | 用途 |
|---|---|
| `glb.js` | 浏览器版 GLB 字节读写，进解析器前清洗非法的 `null` 与空图元 |
| `draco.js` | 按需注入并初始化 Draco 解码器 |
| `process.js` | 压缩流程：修版本 → meshopt 重编码 → 导出字节 |
| `verify.js` | 压缩后的多项属性比对与抽样几何偏差检查 |

### `web/src/viewer/` — 视口与层级树

| 文件 | 用途 |
|---|---|
| `scene.js` | 相机、光照、自动取景、点击/拖拽判定、FPS |
| `bim-batch.js` | 把上万个独立 Mesh 合并为按材质分组的 BatchedMesh，保留逐构件拾取与显隐 |
| `tree.js` | 层级树：四种视图（规范层级 / 系统›类别 / 类别›类型 / 原始结构）、懒加载、名称搜索、显示/隐藏 |
| `discipline.js` | 「专业」判定规则：系统语义优先，缩写、IFC/OmniClass 语义层依次兜底 |
| `system-key.js` | 从属性中提取系统缩写，去掉其后的编号；属性缺失时用构件名兜底 |
| `manual-name.js` | 解析手工命名「系统名_设备名+编号」，供专业判定与系统分组使用 |
| `system-names.js` | 系统缩写到中文系统名的对照表 |

### `web/test/` — 前端测试

| 文件 | 用途 |
|---|---|
| `e2e.mjs` | 真实 Chrome 走全流程（`--no-process` 时只测查看） |
| `acceptance.mjs` | 压缩验收：属性零丢失、材质不变、几何不走形 |
| `verify-view.mjs` | 取景不裁切、树与面板、单击不动相机 |
| `discipline.mjs` | 专业判定规则单测（纯 Node） |
| `system-abbr.mjs` | 「系统名称 → 缩写」归类规则单测（编号不参与） |
| `tree-system.mjs` | 树按「系统」分组的结构断言 |
| `tree-unified.mjs` | 规范层级五级主干、消防优先、叶子不重不漏 |
| `make-fixture-unified.mjs` | 生成跨专业、消防优先等情形的测试样 |
| `report-unknown.mjs` | 体检「其他分类」里的构件、命名规则命中与兜底来源（只读 GLB，不启服务） |
| `manual-name.mjs` | 手工命名规则「系统名_设备名+编号」的解析、归类与格式异常处理 |
| `sanitize.mjs` | 非法的 `null` / 空图元清理回归 |
| `batch-attrs.mjs` | 批处理后仍保留 uv / 顶点色的回归 |
| `batch-default-mat.mjs` | 无材质索引的图元不变黑的回归 |
| `vc-glass.mjs` | 带顶点色的半透明材质不变黑的回归 |
| `visibility.mjs` | 树勾选显隐、组三态、右键菜单与「全部显示」 |
| `click-clear.mjs` | 点构件高亮、点空白处取消 |
| `fixture-systems.glb`、`fixture-unified.glb`、`fixture-vc-glass.glb` | 各类测试用的内置小样 |
| `shot-*.png` | 测试过程截图（不入库） |
