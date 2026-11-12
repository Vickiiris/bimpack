/**
 * report.mjs —— 把一次 build 的全过程渲染成 markdown 交付报告
 *
 * 报告是给"下一个人"看的：他要知道这份文件被怎么处理过、动了什么、还剩什么风险。
 */

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const pct = (a, b) => {
  if (!b) return '—';
  const d = (1 - a / b) * 100;
  return (d >= 0 ? '−' : '+') + Math.abs(d).toFixed(1) + '%';
};
const num = (n) => (n ?? 0).toLocaleString('en-US');

export function renderReport(r) {
  const { name, source, output, build, inspIn, inspOut, params, verify, geo, transferred, warnings = [] } = r;
  const L = [];
  const P = (s = '') => L.push(s);

  P(`# ${name} — BIM GLB 处理报告`);
  P();
  P(`生成时间：${new Date().toLocaleString('zh-CN')}`);
  P();
  P('| | 路径 |');
  P('|---|---|');
  P(`| 输入 | \`${source}\` |`);
  P(`| 输出 | \`${output}\` |`);
  P();

  // ---------- 一、体积 ----------
  P('## 一、体积');
  P();
  P('| 项目 | 输入 | 输出 | 变化 |');
  P('|---|---:|---:|---:|');
  P(`| 文件总大小 | ${mb(inspIn.total)} | ${mb(inspOut.total)} | ${pct(inspOut.total, inspIn.total)} |`);
  P(`| BIN 几何块 | ${mb(inspIn.binLength)} | ${mb(inspOut.binLength)} | ${pct(inspOut.binLength, inspIn.binLength)} |`);
  P(`| JSON 块（含属性） | ${mb(inspIn.jsonLength)} | ${mb(inspOut.jsonLength)} | ${pct(inspOut.jsonLength, inspIn.jsonLength)} |`);
  P(`| 每顶点几何开销 | ${inspIn.geometry.bytesPerVertex} B | ${inspOut.geometry.bytesPerVertex} B | — |`);
  if (transferred?.brotli) {
    P(`| 传输体积（brotli） | — | **${mb(transferred.brotli.length)}** | ${pct(transferred.brotli.length, inspOut.total)} |`);
  }
  if (transferred?.gzip) {
    P(`| 传输体积（gzip） | — | ${mb(transferred.gzip.length)} | ${pct(transferred.gzip.length, inspOut.total)} |`);
  }
  P();
  P(`> 压缩比 **${(inspIn.total / inspOut.total).toFixed(2)}×**；` +
    `brotli 后上到线上的实际字节数 **${mb(transferred?.brotli?.length ?? inspOut.total)}**。`);
  P();

  // ---------- 二、压缩参数 ----------
  P('## 二、Draco 参数');
  P();
  P('| 参数 | 取值 | 说明 |');
  P('|---|---|---|');
  P(`| preset | ${params.preset} | 量化位深预设 |`);
  P(`| method | ${params.method} | 连通性压缩算法 |`);
  P(`| quantizePosition | **${params.quantizePosition} bit** | 位置精度，误差上限 = 构件尺寸 / 2^${params.quantizePosition} |`);
  P(`| quantizeNormal | ${params.quantizeNormal} bit | 法线八面体编码 |`);
  P(`| quantizeTexcoord | ${params.quantizeTexcoord} bit | UV 精度（无贴图时无关） |`);
  P(`| encodeSpeed | ${params.encodeSpeed} | 编码速度（越大越快、压缩率略低） |`);
  P();
  P('未启用 weld / simplify / prune / join —— 任何拓扑或图元结构改动都会破坏构件一一对应。');
  P();

  // ---------- 三、属性保留 ----------
  if (verify) {
    P('## 三、BIM 属性与结构校验');
    P();
    P('| 校验项 | 输入 | 输出 | 结论 |');
    P('|---|---:|---:|---|');
    for (const row of verify.rows) {
      const a = typeof row.a === 'number' ? num(row.a) : String(row.a ?? '');
      const b = typeof row.b === 'number' ? num(row.b) : String(row.b ?? '');
      P(`| ${row.label} | ${a || '—'} | ${b || '—'} | ${row.ok ? 'PASS' : '**FAIL**'} |`);
    }
    P();
    P(verify.pass ? '**全部通过。**' : '**存在失败项，该文件不应交付。**');
    P();
    P(`属性总条目 ${num(inspOut.extras.propEntries)} 条 / ${num(inspOut.extras.distinctKeys)} 个键，` +
      `占 JSON ${inspOut.extras.percentOfJSON}%。`);
    P();
  }

  // ---------- 四、几何保真 ----------
  if (geo) {
    P('## 四、几何保真度实测');
    P();
    P('| 指标 | 结果 |');
    P('|---|---|');
    P(`| 抽样图元 / 顶点 | ${num(geo.sampledPrims)} / ${num(geo.sampledVertices)} |`);
    P(`| 顶点位置最大偏差 | **${geo.maxDeviation.toFixed(4)} 模型单位** |`);
    P(`| 顶点位置平均偏差 | ${geo.meanDeviation.toFixed(5)} 模型单位 |`);
    P(`| 三角面总面积相对差 | ${geo.areaDiffPercent.toFixed(4)}% |`);
    P();
    const scale = inspIn.bbox?.extent ? Math.max(...inspIn.bbox.extent) : 0;
    if (scale) P(`模型最大跨度 ${num(Math.round(scale))} 单位；最大偏差相当于其 ${(geo.maxDeviation / scale * 1e6).toFixed(1)} ppm。`);
    P();
  }

  // ---------- 五、three.js 落地 ----------
  P('## 五、three.js 落地参数');
  P();
  P('| 指标 | 值 |');
  P('|---|---|');
  P(`| 节点 / 网格 / 图元 | ${num(inspOut.counts.nodes)} / ${num(inspOut.counts.meshes)} / ${num(inspOut.counts.primitives)} |`);
  P(`| 顶点 / 三角面 | ${num(inspOut.geometry.vertices)} / ${num(inspOut.geometry.triangles)} |`);
  P(`| 材质表条数 | ${inspOut.counts.materials} |`);
  P(`| **实际批次（draw call）** | **${inspOut.counts.materialGroups}** |`);
  P(`| 是否含贴图 | ${inspOut.counts.textures > 0 ? '是，必须保留 UV' : '否，UV 可剥离'} |`);
  P();
  P('按材质分组明细（前三组）：');
  P();
  P('| 材质 | 几何数 | 顶点数 |');
  P('|---|---:|---:|');
  for (const b of inspOut.batches.slice(0, 5)) P(`| ${b.name} | ${num(b.geometryCount)} | ${num(b.vertices)} |`);
  P();
  P(`→ viewer 会把 ${num(inspOut.counts.primitives)} 次 draw call 收敛到 **${inspOut.counts.materialGroups}** 次。`);
  P();

  // ---------- 六、风险 ----------
  const risk = [...(warnings || [])];
  if (inspIn.alreadyDraco) risk.push('源文件已是 Draco → 本次属二次编码，几何信息经过两轮量化，精度不可逆');
  if (verify && !verify.pass) risk.push('JSON 校验未通过，必须排查后再交付');
  P('## 六、风险与注意事项');
  P();
  if (risk.length) for (const x of risk) P(`- ${x}`);
  else P('- 无');
  P();
  P('---');
  P();
  P('复现命令：');
  P();
  P('```bash');
  P(`node src/cli.mjs build "${source}" --preset ${params.preset}`);
  P('```');

  return L.join('\n');
}
