# BIM Pack Web · GLB 处理与查看

纯前端（浏览器内运行）的 GLB 处理工具：**拖入模型 → 体检 → 压缩 → 3D 预览 → 层级树 → 下载**。
不依赖 Node 服务、不上传文件，所有计算都在本地浏览器完成。

打开的界面就是拖放区——不自动加载任何模型。

---

## 怎么跑

```bash
cd bimpack/web
npm install          # 只需第一次
npm run dev          # → http://localhost:5173
```

构建成静态站点（可丢到任意静态托管：GitHub Pages / OSS / COS / Nginx）：

```bash
npm run build        # 产物在 dist/，用相对路径，放子目录也能跑
npm run preview      # 本地预览构建产物
```

> `dist/` 是纯静态文件，没有任何服务端依赖。但**不能直接双击 index.html**——
> ES module 和 wasm 在 `file://` 下会被浏览器的同源策略拦住，必须走一个静态服务器。

---

## 能干什么

| 能力 | 说明 |
|---|---|
| **直接查看** | 拖入 `.glb` 立刻渲染，不做任何几何改动（只修非法的 `asset.version`） |
| **压缩处理** | reorder + meshopt FILTER 编码，实测 208 MB → 113 MB（−45.7%） |
| **层级树** | 完整节点树，懒加载渲染 + 名称搜索；点节点联动 3D 高亮与属性面板 |
| **BIM 属性** | 点构件看全部 `extras` 用户属性（实测单构件 71 条） |
| **批处理渲染** | 12,209 个独立 Mesh → **29 个 draw call**（按材质分组） |
| **校验闸门** | 压缩后跑 19 项比对，任何一项不过都不会让你下载 |
| **下载** | 处理后的 `.glb`，或仅修过版本的原始文件 |

### 交互

- 左键拖 = 旋转，右键拖 = 平移，滚轮 = 缩放
- 单击构件 = 选中（橙色高亮）+ 树上自动展开定位
- 树上点节点 = 相机飞过去 + 右侧出属性
- 搜索框输名称 = 全树过滤
- `Esc` = 取消选中

---

## 压缩用的是 meshopt，不是 Draco

这不是随手换的技术选型，是实测后的唯一可行路径：

| 方案 | 结果 |
|---|---|
| Draco 编码（官方 npm `draco3d`） | **不行**。只有 Node 版 glue，浏览器里 `require('fs')` 直接炸 |
| Draco 编码（three.js 自带 `draco_encoder.js`，asm.js） | **不行**。Chrome 157 里一初始化就 `Target crashed`，换 `TOTAL_MEMORY` 等参数无效 |
| gltf-transform 的 `meshopt()` 封装 | **不行**。内部强制调 `quantize()`，会把 `KHR_materials_volume.thicknessFactor` 按节点缩放改写（0.2 → 0.00024），共用材质还会被克隆出多份 |
| **`reorder()` + `EXT_meshopt_compression` FILTER** | **可行**。顶点保持 Float32、材质与节点变换一字不动，压缩率反而更高（−45.7% vs −29.7%） |

Draco 的**解码器**仍然保留（`public/draco/draco_decoder.js`，asm.js 版），用来读入「源文件本身就被 Draco 压过」的情况——你的 3ds Max 导出基本都属于这种。

**所以输出的扩展名是 `EXT_meshopt_compression`**，不是 `KHR_draco_mesh_compression`。three.js 的 `GLTFLoader` 两者都原生支持，用法没有任何区别（本项目里 `setMeshoptDecoder()` 已接好）。

---

## 实测数据（117_T_31F A&S&MEP，208.24 MB）

```
耗时        压缩 37.3 s（含校验收尾 67 s 全流程）
体积        208.24 MB → 112.97 MB   −45.7%
节点        12,244 → 12,244
图元        12,209 → 12,209
材质        53 → 53（逐份一致）
属性条目    795,727 → 795,727（12,244 条 extras 逐条一致）
三角面      7,937,261 → 7,937,261
变换        角点最大位移 2.96e-7 单位
几何        世界坐标包围盒最大偏移 0.111 单位（模型跨度 59,357）
渲染        29 draw call / 7.28M 顶点 / 12,484 树节点
内存        堆峰值约 2.5 GB
```

校验闸门 19 项**全部通过**才允许下载。

---

## 已知限制

1. **内存**。208 MB / 748 万顶点的文件，浏览器堆峰值约 2.5 GB。16 GB 内存的机器够用；
   如果你有更夸张的楼层（比如 500 MB+），建议还是走 `bimpack` 的 Node CLI（见上级目录 README）。
2. **压缩率不如 Draco**。浏览器里做不到 Node 版 Draco 的 −69%，FILTER 编码的上限就在这。
   想压得更狠，用 Node CLI 的 `gltf-transform draco`。
3. **文件体积太小时压缩反而变大**（1.2 KB → 1.8 KB），因为多了扩展声明和 bufferView 头。
   小文件建议直接用「下载」拿修过版本的原始文件。
4. **首屏解码时间**。208 MB 约 24–30 秒（软件渲染环境），真实 GPU 环境会更快；
   期间进度卡会显示到了哪一步。

---

## 目录结构

```
web/
├── index.html              单页布局（顶栏 / 左树 / 中视口 / 右属性）
├── vite.config.js          base:'./'，产物可放任意子路径
├── public/draco/
│   └── draco_decoder.js    仅解码器（读 Draco 源文件用）
├── src/
│   ├── main.js             编排：拖入 → 体检 → 压缩 → 渲染 → 树/属性联动 → 下载
│   ├── style.css
│   ├── core/
│   │   ├── glb.js          GLB 字节级读写 + asset.version 修正（零依赖）
│   │   ├── process.js      WebIO + reorder + meshopt FILTER，体检
│   │   ├── verify.js       19 项属性/材质/几何校验
│   │   └── draco.js        asm.js Draco 解码器加载
│   └── viewer/
│       ├── scene.js        相机 / 光照 / 取景 / 拾取 / FPS
│       ├── bim-batch.js    BatchedMesh 批处理（含量化顶点反归一化）
│       └── tree.js         层级树（懒渲染 + 搜索）
└── test/
    ├── e2e.mjs             真实 Chrome 端到端（需先 npm run dev）
    └── acceptance.mjs      压缩验收：属性零丢失 / 材质不变 / 几何不走形
```

### 跑测试

```bash
npm run dev            # 另开一个终端保持运行
node test/e2e.mjs "路径/模型.glb"          # 完整流程 + 自动截图
node test/e2e.mjs "路径/模型.glb" --no-process   # 只看不压
node test/acceptance.mjs "路径/模型.glb"   # 只测压缩质量，输出逐项校验
```

测试用系统装好的 Chrome（`channel: 'chrome'`），不需要额外下载浏览器。

---

## 与 Node CLI（上级目录）的分工

| | Web 版（本目录） | Node CLI（`../`） |
|---|---|---|
| 使用方式 | 浏览器拖文件，零安装 | 命令行 / 批处理 |
| 压缩算法 | meshopt FILTER | Draco（edgebreaker） |
| 压缩率 | −45.7% | −69.6% |
| 属性校验 | 19 项（JSON + 世界坐标几何） | 19 项（含逐顶点最近邻偏差） |
| 适合 | 单层快速处理、现场看模型、给非技术同事用 | 批量出交付物、极致压缩、CI 集成 |

两者产物的 `userData` / `extras` 都是零丢失，可以互相替换。
