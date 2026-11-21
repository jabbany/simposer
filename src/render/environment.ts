// Ground and props.

import { BoxGeometry, CanvasTexture, Color, GridHelper, Group, Mesh, MeshStandardMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace } from 'three';
import type { Material } from 'three';
import type { Prop } from '../dsl/types.ts';
import type { GroundKind } from '../dsl/vocab.ts';

const DEG = Math.PI / 180;

function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: Material): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildProp(p: Prop, mat: Material): Group {
  const g = new Group();
  g.name = `prop:${p.id}`;
  g.userData['propId'] = p.id;
  const [w, h, d] = p.size;
  switch (p.kind) {
    case 'chair': {
      const seatH = Math.min(h, 0.46);
      const t = 0.04;
      g.add(box(w, t, d, 0, seatH - t / 2, 0, mat));
      g.add(box(w, h - seatH, t, 0, seatH + (h - seatH) / 2, -d / 2 + t / 2, mat));
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          g.add(box(t, seatH - t, t, sx * (w / 2 - t / 2), (seatH - t) / 2, sz * (d / 2 - t / 2), mat));
        }
      }
      break;
    }
    case 'bench': {
      const t = 0.05;
      g.add(box(w, t, d, 0, h - t / 2, 0, mat));
      for (const sx of [-1, 1]) {
        g.add(box(0.06, h - t, d * 0.9, sx * (w / 2 - 0.15), (h - t) / 2, 0, mat));
      }
      break;
    }
    case 'table': {
      const t = 0.04;
      g.add(box(w, t, d, 0, h - t / 2, 0, mat));
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          g.add(box(0.05, h - t, 0.05, sx * (w / 2 - 0.06), (h - t) / 2, sz * (d / 2 - 0.06), mat));
        }
      }
      break;
    }
    default:
      g.add(box(w, h, d, 0, h / 2, 0, mat));
  }
  g.position.set(p.x, 0, p.z);
  g.rotation.y = p.facing * DEG;
  return g;
}

function streetTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  if (ctx === null) {
    throw new Error('2d canvas unavailable');
  }
  ctx.fillStyle = '#b9b6ae';
  ctx.fillRect(0, 0, 512, 512);
  // paving joints
  ctx.strokeStyle = '#a7a39a';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(20, 20);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function buildGround(kind: GroundKind): Group {
  const g = new Group();
  g.name = 'ground';
  const size = 80;
  if (kind === 'street') {
    const pave = new Mesh(new PlaneGeometry(size, size), new MeshStandardMaterial({ map: streetTexture(), roughness: 0.95 }));
    pave.rotation.x = -Math.PI / 2;
    pave.receiveShadow = true;
    g.add(pave);
    const road = new Mesh(new PlaneGeometry(7, size), new MeshStandardMaterial({ color: new Color(0x55585c), roughness: 0.95 }));
    road.rotation.x = -Math.PI / 2;
    road.position.set(-9, 0.002, 0);
    road.receiveShadow = true;
    g.add(road);
    const dashMat = new MeshStandardMaterial({ color: 0xe8e2c8, roughness: 0.8 });
    for (let z = -size / 2; z < size / 2; z += 4) {
      const dash = new Mesh(new PlaneGeometry(0.15, 2), dashMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(-9, 0.004, z);
      dash.receiveShadow = true;
      g.add(dash);
    }
    for (const x of [-5.45, -12.55]) {
      const curb = new Mesh(new PlaneGeometry(0.2, size), new MeshStandardMaterial({ color: 0x8e8b84 }));
      curb.rotation.x = -Math.PI / 2;
      curb.position.set(x, 0.003, 0);
      curb.receiveShadow = true;
      g.add(curb);
    }
    return g;
  }
  const floor = new Mesh(new PlaneGeometry(size, size), new MeshStandardMaterial({ color: kind === 'grid' ? 0xc4c7cc : 0xbfbab0, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);
  if (kind === 'grid') {
    const grid = new GridHelper(size, size, 0x8a9099, 0xa8adb4);
    grid.position.y = 0.002;
    g.add(grid);
  }
  return g;
}
