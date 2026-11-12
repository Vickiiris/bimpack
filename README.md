# bimpack — BIM GLB 预览与压缩

把「Revit → 3ds Max → GLB → 网页」这条路上踩过的坑，固化成两个能直接用的东西：

| 目录 | 是什么 | 怎么用 |
|---|---|---|
| **`web/`** | **纯前端应用：上传 → 预览 → 压缩 → 层级树 → 下载** | `cd web && npm i && npm run dev` |
| `src/` | 命令行批处理：版本修正 → Draco 压缩 → 19 项校验 → 报告 | `node src/cli.mjs build <file.glb>` |

日常用 `web/` 就够了：浏览器里拖文件，不上传、不需要服务端。
`src/` 是同一套逻辑的命令行版，适合批量出交付物、或者机器内存不够跑浏览器的时候。

> 仓库里**只放代码**，不放模型：`inbox/`、`out/`、`*.glb`、`dist/` 都在 `.gitignore` 里。
> 本机的 Draco 极限压缩小工具**不在本仓库**（见文末）。

---

## 一、前端应用（web/）

```bash
cd web
npm install        # 只需第一次
npm run dev        # → http://localhost:5173
```

构建成静态站点（GitHub Pages / OSS / COS / Nginx 都行，产物是纯静态、相对路径）：

```bash
npm run build      # → web/dist/
npm run preview    # 本地预览构建产物
```

打开页面就是一个拖放区，**不会自动加载任何模型**；把 `.glb` 拖进去即可。

能做的事：

- **直接查看**：只修非法的 `asset.version`，几何一字不动
- **压缩处理**：`reorder` + `EXT_meshopt_compression` FILTER，实测 208.24 MB → 112.97 MB（−45.7%）
- **层级树**：源文件是平铺的，按 `extras` 合成「类别 → 类型 → 构件」，也能切系统 / 族 / 标高
- **BIM 属性**：点构件看全部 `extras`（实测单构件 71 条）
- **批处理渲染**：12,209 个 Mesh → 29 个 draw call
- **校验闸门**：压缩后 19 项比对全过才允许下载

详细说明、交互约定、实测数据、每个坑的来龙去脉都在 **[`web/README.md`](web/README.md)**。

### 交互速查

| 操作 | 结果 |
|---|---|
| 单击构件 / 树节点 | 高亮 + 右侧属性，**相机不动** |
| 双击 | 相机定位到该构件 |
| `F` / 「适应视图」 | 回到能看全整个模型的角度 |
| `1` / `2` | 收起、展开左侧层级树 / 右侧属性 |
| 搜索框 | 全树按名称过滤，点结果直接选中 |
| `Esc` | 取消选中 |

---

## 二、命令行（src/）

```bash
node src/cli.mjs inspect <file.glb>        # 体检：节点/图元/材质/属性/字节每顶点，秒级
node src/cli.mjs build   <file.glb>        # 全流程：修版本 → Draco → 校验 → 预压缩(.br/.gz) → report.md
node src/cli.mjs verify  <a.glb> <b.glb>   # 只比两个文件（属性 + 可选几何）
```

`build` 常用选项：

```
--preset high|balance|small   量化位深（默认 balance；源已是 Draco 时自动升为 high）
--out <dir>                   输出根目录（默认 ./out）
--name <slug>                 输出目录名
--no-geo                      跳过解码级几何比对（更快）
--no-gzip                     只要 .br，不生成 .gz
```

产物目录里会有 `report.md`、`manifest.json` 和预压缩文件。配置在 `bim.config.json`。

208 MB / 795,727 条属性这条链路要 8 GB 堆，CLI 会自动用子进程放大堆，不用手动加参数。

---

## 实测数据（117_T_31F A&S&MEP）

| | 体积 | 用时 | 说明 |
|---|---|---|---|
| 原始（3ds Max 导出，自带低压缩 Draco） | 208.24 MB | — | 25.46 字节/顶点 |
| 浏览器（`web/`，meshopt FILTER） | 112.97 MB　**−45.7%** | ~37 s | 顶点保持 Float32，材质零改动 |
| 命令行 / 本地 Draco（`src/`，edgebreaker） | 60.67 MB　**−70.9%** | 17.3 s | 量化 14–16 bit，需 Node |

两条路径的属性都是零丢失：

```
节点        12,244 → 12,244
图元        12,209 → 12,209
材质        53 → 53（逐份一致）
属性条目    795,727 → 795,727
三角面      7,937,261 → 7,937,261
渲染        29 draw call（原 12,209）
```

---

## 几个绕不开的结论

1. **浏览器里做不了 Draco 编码。** npm 的 `draco3d` 只有 Node 版 glue；
   three.js 自带的 asm.js 编码器在 Chrome 里一初始化就 `Target crashed`。
   所以前端走 meshopt（`EXT_meshopt_compression`），Draco 走命令行 / 本地工具。
2. **不要用 gltf-transform 的 `meshopt()` 封装。** 它内部强制 `quantize()`，
   会把 `KHR_materials_volume.thicknessFactor` 按节点缩放改写（0.2 → 0.00024），
   共用材质还会被克隆成多份。这里是 `reorder()` + 手动挂 FILTER 扩展。
3. **已经压到极限的文件不再压。** 量化解回 float32 再编码必然膨胀（实测 63.63 → 115.34 MB）。
   判据是**每顶点几何字节数**，不是「有没有 Draco 扩展」——3ds Max 原始导出本身就带 Draco，
   只是压缩设置低。低于 8 B/顶点就判定为够了。
4. **3ds Max 的 GLB 没有层级。** 12,244 个节点全在根上、最大深度 0，所以树是按 BIM 属性合成的。
5. **`asset.version` 常写成 `2.1`**，而规范只允许 `2.0`，three.js / glTF-Transform 都会直接拒载。
   前端和 CLI 都会在字节层改成 `2.0`（导出侧后面选 2.0 就不需要这步了）。
6. **有的导出会写出规范不允许的 `null`**（`"targets": null`、`"weights": null`），
   three 的 GLTFLoader 会一路走到 `null.length`，报一句 `Cannot read properties of null (reading 'length')`。
   前端进解析器前会清洗掉这些 null（`extras` 里的保留），细节见 [`web/README.md`](web/README.md)。

---

## 目录结构

```
bimpack/
├── web/                     纯前端应用（主入口）
│   ├── index.html
│   ├── vite.config.js       base:'./'，产物可放任意子路径
│   ├── public/draco/        Draco 解码器（asm.js，只用来读 Draco 源文件）
│   ├── src/
│   │   ├── main.js          页面编排：拖入 → 体检 → 压缩 → 渲染 → 树/属性联动 → 下载
│   │   ├── core/            GLB 字节读写 / 体检 / meshopt 压缩 / 19 项校验
│   │   └── viewer/          相机与取景 / BatchedMesh 批处理 / 层级树
│   └── test/                e2e、压缩验收、取景断言（真实 Chrome）
├── src/                     命令行批处理
│   ├── cli.mjs              inspect / build / verify
│   ├── glb.mjs, inspect.mjs
│   ├── compress.mjs         Draco 编码（gltf-transform + draco3dgltf）
│   ├── verify.mjs           属性 / 材质 / 几何比对
│   ├── precompress.mjs      .br / .gz 预压缩
│   └── report.mjs           report.md 生成
├── test/                    CLI 批处理回归
├── bim.config.json
└── package.json
```

## 测试

```bash
# 前端（需要先 npm run dev 起服务，用系统 Chrome，不下载浏览器）
cd web
node test/e2e.mjs "路径/模型.glb"                 # 全流程 + 截图
node test/e2e.mjs "路径/模型.glb" --no-process    # 只看不压
node test/acceptance.mjs "路径/模型.glb"          # 压缩质量逐项校验
node test/verify-view.mjs "路径/模型.glb"         # 取景是否裁切 / 树 / 面板 / 单击不动相机

# 命令行
npm test
```

---

## 不在本仓库里的东西

**本地 Draco 极限压缩小工具**（双击 `start.cmd`、拖放、三档位深、自动跑 19 项校验）
放在本机 `local-tools/draco-tool/`，不随仓库走。它复用 `src/` 的压缩与校验模块，
所以两个文件夹保持同级即可。本文档只描述仓库内的 `web/` 与 `src/`。
