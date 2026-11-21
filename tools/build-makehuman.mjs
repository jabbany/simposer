// Converts the CC0 MakeHuman assets (see fetch-makehuman.mjs) into a compact
// kit the app loads at runtime: public/models/makehuman/kit.json + kit.bin.
//
// Usage: node tools/build-makehuman.mjs [srcDir=vendor/makehuman] [outDir=public/models/makehuman]
//
// Kit contents
//   base vertex positions (meters, Y up, facing +Z), all 19158 MakeHuman verts
//     (helper "joint cube" verts are kept so joints can be recomputed after morphing)
//   triangle indices of the rendered groups (body + eyes)
//   skin: 4 bone indices + 4 weights per vertex (game-engine rig)
//   bones: name, parent, head/tail joint definitions (vertex index lists)
//   targets: sparse vertex offsets, int16 in units of 0.1 mm
//     neutral-{gender}-{age}            mean of the african/asian/caucasian targets
//     universal-{gender}-{age}-{muscle}-{weight}
//     breast-female-{age}-{muscle}-{weight}-{cup}

import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2] ?? 'vendor/makehuman';
const out = process.argv[3] ?? 'public/models/makehuman';
const DM = 0.1; // MakeHuman units are decimeters
const Q = 1e-4; // target quantization step in meters
const RENDER_GROUPS = new Set(['body', 'helper-l-eye', 'helper-r-eye']);

// ---------------------------------------------------------------- mesh

const verts = [];
const groupVerts = new Map(); // group -> Set of vertex indices
const tris = [];
let group = '';
for (const line of fs.readFileSync(path.join(src, 'base.obj'), 'utf8').split('\n')) {
  if (line.startsWith('v ')) {
    const [, x, y, z] = line.trim().split(/\s+/);
    verts.push(Number(x) * DM, Number(y) * DM, Number(z) * DM);
  } else if (line.startsWith('g ')) {
    group = line.trim().split(/\s+/)[1] ?? '';
  } else if (line.startsWith('f ')) {
    const idx = line.trim().split(/\s+/).slice(1).map((t) => Number(t.split('/')[0]) - 1);
    let set = groupVerts.get(group);
    if (set === undefined) {
      set = new Set();
      groupVerts.set(group, set);
    }
    for (const i of idx) {
      set.add(i);
    }
    if (RENDER_GROUPS.has(group)) {
      for (let k = 1; k + 1 < idx.length; k++) {
        tris.push(idx[0], idx[k], idx[k + 1]);
      }
    }
  }
}
const nVerts = verts.length / 3;
console.log(`mesh: ${nVerts} verts, ${tris.length / 3} rendered triangles`);

// ---------------------------------------------------------------- rig

const rig = JSON.parse(fs.readFileSync(path.join(src, 'rig.game_engine.json'), 'utf8'));
const jointVerts = (spec) => {
  if (spec.strategy === 'CUBE') {
    const set = groupVerts.get(spec.cube_name);
    if (set === undefined) {
      throw new Error(`missing joint cube ${spec.cube_name}`);
    }
    return [...set];
  }
  if (spec.strategy === 'MEAN' || spec.strategy === 'VERTEX') {
    return spec.vertex_indices ?? [spec.vertex_index];
  }
  throw new Error(`unsupported joint strategy ${spec.strategy}`);
};
// order bones parents-first
const names = Object.keys(rig);
const ordered = [];
const placed = new Set();
while (ordered.length < names.length) {
  for (const n of names) {
    const p = rig[n].parent;
    if (!placed.has(n) && (p === '' || placed.has(p))) {
      ordered.push(n);
      placed.add(n);
    }
  }
}
const bones = ordered.map((n) => ({ name: n, parent: rig[n].parent === '' ? -1 : ordered.indexOf(rig[n].parent), head: jointVerts(rig[n].head), tail: jointVerts(rig[n].tail) }));

// ---------------------------------------------------------------- skin weights

const weights = JSON.parse(fs.readFileSync(path.join(src, 'weights.game_engine.json'), 'utf8')).weights;
const perVert = Array.from({ length: nVerts }, () => []);
for (const [bone, list] of Object.entries(weights)) {
  const bi = ordered.indexOf(bone);
  if (bi < 0) {
    continue;
  }
  for (const [v, w] of list) {
    if (w > 0) {
      perVert[v].push([bi, w]);
    }
  }
}
const headBone = ordered.indexOf('head');
const skinIndex = new Uint8Array(nVerts * 4);
const skinWeight = new Uint8Array(nVerts * 4);
let unweighted = 0;
const rendered = new Set(tris);
for (let v = 0; v < nVerts; v++) {
  let list = perVert[v].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (list.length === 0) {
    if (rendered.has(v)) {
      unweighted++;
    }
    list = [[headBone, 1]]; // eyes and helpers ride on the head
  }
  // quantize to bytes that sum to exactly 255 (floor, then hand the remainder to the largest)
  const sum = list.reduce((a, [, w]) => a + w, 0);
  const q = list.map(([, w]) => Math.floor((w / sum) * 255));
  q[0] += 255 - q.reduce((a, b) => a + b, 0);
  list.forEach(([bi], k) => {
    skinIndex[v * 4 + k] = bi;
    skinWeight[v * 4 + k] = q[k];
  });
}
console.log(`skin: ${ordered.length} bones, ${unweighted} rendered verts without weights (assigned to head)`);

// ---------------------------------------------------------------- landmarks for proportions

// chin: lowest point of the face (front of the head-weighted body verts); crown: highest body vert
const body = groupVerts.get('body');
let chin = -1;
let crown = -1;
for (const v of body) {
  const y = verts[v * 3 + 1];
  const z = verts[v * 3 + 2];
  const isHead = perVert[v].some(([bi, w]) => bi === headBone && w > 0.95);
  if (isHead && z > 0.04 && (chin < 0 || y < verts[chin * 3 + 1])) {
    chin = v;
  }
  if (crown < 0 || y > verts[crown * 3 + 1]) {
    crown = v;
  }
}

// ---------------------------------------------------------------- targets

const readTarget = (file) => {
  const dense = new Float32Array(nVerts * 3);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0 || line[0] === '#') {
      continue;
    }
    const [i, x, y, z] = line.trim().split(/\s+/).map(Number);
    dense[i * 3] = x * DM;
    dense[i * 3 + 1] = y * DM;
    dense[i * 3 + 2] = z * DM;
  }
  return dense;
};

const chunks = [];
let offset = 0;
const push = (typed) => {
  const pad = (4 - (offset % 4)) % 4;
  if (pad > 0) {
    chunks.push(Buffer.alloc(pad));
    offset += pad;
  }
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(buf);
  const at = offset;
  offset += buf.length;
  return at;
};

const targets = [];
const addTarget = (name, dense) => {
  const idx = [];
  const d = [];
  for (let v = 0; v < nVerts; v++) {
    const x = Math.round(dense[v * 3] / Q);
    const y = Math.round(dense[v * 3 + 1] / Q);
    const z = Math.round(dense[v * 3 + 2] / Q);
    if (x !== 0 || y !== 0 || z !== 0) {
      idx.push(v);
      d.push(x, y, z);
    }
  }
  if (idx.length === 0) {
    return;
  }
  if (d.some((q) => q > 32767 || q < -32768)) {
    throw new Error(`target ${name} exceeds int16 range`);
  }
  targets.push({ name, count: idx.length, indices: push(new Uint16Array(idx)), deltas: push(new Int16Array(d)) });
};

const T = (n) => path.join(src, 'targets', `${n}.target`);
const genders = ['female', 'male'];
const ages = ['baby', 'child', 'young', 'old'];
const lv = (w) => [`min${w}`, `average${w}`, `max${w}`];
for (const g of genders) {
  for (const a of ages) {
    const sum = new Float32Array(nVerts * 3);
    for (const r of ['african', 'asian', 'caucasian']) {
      const t = readTarget(T(`${r}-${g}-${a}`));
      for (let k = 0; k < sum.length; k++) {
        sum[k] += t[k] / 3;
      }
    }
    addTarget(`neutral-${g}-${a}`, sum);
    for (const m of lv('muscle')) {
      for (const w of lv('weight')) {
        addTarget(`universal-${g}-${a}-${m}-${w}`, readTarget(T(`universal-${g}-${a}-${m}-${w}`)));
      }
    }
  }
}
for (const a of ['child', 'young', 'old']) {
  for (const m of lv('muscle')) {
    for (const w of lv('weight')) {
      for (const cup of ['mincup', 'maxcup']) {
        addTarget(`breast-female-${a}-${m}-${w}-${cup}`, readTarget(T(`breast-female-${a}-${m}-${w}-${cup}-averagefirmness`)));
      }
    }
  }
}

const positions = push(new Float32Array(verts));
const indices = push(new Uint16Array(tris));
const skinIdx = push(skinIndex);
const skinW = push(skinWeight);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'kit.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(out, 'kit.json'), JSON.stringify({
  format: 'simposer-makehuman-kit',
  version: 1,
  license: 'CC0 1.0 (MakeHuman base mesh, targets and MPFB2 game-engine rig/weights, makehumancommunity)',
  vertexCount: nVerts,
  triangleCount: tris.length / 3,
  quantization: Q,
  positions,
  indices,
  skinIndex: skinIdx,
  skinWeight: skinW,
  landmarks: { chin, crown },
  bones,
  targets: targets.map((t) => ({ name: t.name, count: t.count, indices: t.indices, deltas: t.deltas })),
}));
console.log(`targets: ${targets.length}; kit.bin ${(offset / 1e6).toFixed(2)} MB; chin vertex ${chin}, crown vertex ${crown}`);
