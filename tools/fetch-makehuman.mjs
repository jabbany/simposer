// Downloads the CC0 MakeHuman assets needed to build the figure kit.
// Usage: node tools/fetch-makehuman.mjs [outDir=vendor/makehuman]
//
// Sources (CC0 since 2020, see https://static.makehumancommunity.org/makehuman/faq/are_makehuman_files_free.html):
//   makehumancommunity/makehuman  data/3dobjs/base.obj, data/targets/{macrodetails,breast}
//   makehumancommunity/mpfb2      src/mpfb/data/rigs/standard/{rig,weights}.game_engine.json

import fs from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2] ?? 'vendor/makehuman';
const MH = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data';
const MPFB = 'https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/src/mpfb/data/rigs/standard';

const genders = ['female', 'male'];
const ages = ['baby', 'child', 'young', 'old'];
const races = ['african', 'asian', 'caucasian'];
const levels = (w) => [`min${w}`, `average${w}`, `max${w}`];

const files = [
  [`${MH}/3dobjs/base.obj`, 'base.obj'],
  [`${MPFB}/rig.game_engine.json`, 'rig.game_engine.json'],
  [`${MPFB}/weights.game_engine.json`, 'weights.game_engine.json'],
];
for (const r of races) {
  for (const g of genders) {
    for (const a of ages) {
      files.push([`${MH}/targets/macrodetails/${r}-${g}-${a}.target`, `targets/${r}-${g}-${a}.target`]);
    }
  }
}
for (const g of genders) {
  for (const a of ages) {
    for (const m of levels('muscle')) {
      for (const w of levels('weight')) {
        const n = `universal-${g}-${a}-${m}-${w}`;
        files.push([`${MH}/targets/macrodetails/${n}.target`, `targets/${n}.target`]);
      }
    }
  }
}
// cup size for female figures (average firmness); MakeHuman has no baby breast targets
for (const a of ['child', 'young', 'old']) {
  for (const m of levels('muscle')) {
    for (const w of levels('weight')) {
      for (const cup of ['mincup', 'maxcup']) {
        const n = `female-${a}-${m}-${w}-${cup}-averagefirmness`;
        files.push([`${MH}/targets/breast/${n}.target`, `targets/breast-${n}.target`]);
      }
    }
  }
}

await fs.mkdir(path.join(out, 'targets'), { recursive: true });
let ok = 0;
let skipped = 0;
const missing = [];
// small concurrency pool
const queue = [...files];
async function worker() {
  for (;;) {
    const next = queue.shift();
    if (next === undefined) {
      return;
    }
    const [url, rel] = next;
    const dest = path.join(out, rel);
    try {
      await fs.access(dest);
      skipped++;
      continue;
    } catch {
      // not downloaded yet
    }
    const res = await fetch(url);
    if (!res.ok) {
      missing.push(`${res.status} ${url}`);
      continue;
    }
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    ok++;
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`downloaded ${ok}, already present ${skipped}, missing ${missing.length} of ${files.length}`);
for (const m of missing) {
  console.log(`  missing: ${m}`);
}
