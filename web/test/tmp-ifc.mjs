import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 12, json = null;
while (off < buf.byteLength) {
  const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
  if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
  off += 8 + len;
}
const keys = ['导出到 IFC','导出类型到 IFC','OmniClass 编号','OmniClass 标题','IfcGUID','类型 IfcGUID'];
for (const k of keys) {
  const m = new Map();
  for (const n of json.nodes || []) { const v = n.extras?.[k]; if (v !== undefined && v !== '') m.set(String(v), (m.get(String(v))||0)+1); }
  console.log(`--- ${k}: ${m.size} 种 ---`);
  console.log([...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([v,c])=>`${v}×${c}`).join(' | ') || '(无)');
}
