// Model catalog: the parametric human figure (MakeHuman CC0 kit), glTF models
// listed in public/models/manifest.json, and models the user imports by
// drag-and-drop (kept in IndexedDB so they survive reloads and work offline).

import { Box3, Group, Mesh } from 'three';
import type { Material, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { BodyParams } from '../dsl/vocab.ts';
import { autoMapBones, missingRequired } from './boneMap.ts';
import type { BoneMap } from './boneMap.ts';
import { HumanKit } from './makehuman.ts';

export interface ModelEntry {
  id: string;
  label: string;
  description: string;
  defaultBody: string;
  /** human: parametric MakeHuman figure that follows all body parameters */
  kind: 'human' | 'gltf';
  url: string | null;
  boneMap: BoneMap;
  source: string;
  imported: boolean;
}

interface ManifestEntry {
  id: string;
  file: string;
  label?: string;
  description?: string;
  defaultBody?: string;
  source?: string;
  boneMap?: BoneMap;
}

interface Template {
  scene: Object3D;
  map: BoneMap;
}

export const HUMAN: ModelEntry = {
  id: 'human',
  label: 'Human figure',
  description: 'realistic neutral human; follows age, gender, height, build, muscle, bust/hip, heads and leg length',
  defaultBody: 'adult_male',
  kind: 'human',
  url: 'models/makehuman',
  boneMap: {},
  source: 'MakeHuman base mesh and targets, MPFB2 game-engine rig (CC0)',
  imported: false,
};

/** older names that still resolve, so saved scenes keep working */
const MODEL_ALIASES: Record<string, string> = { mannequin: 'human' };

const DB_NAME = 'simposer';
const STORE = 'models';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

interface StoredModel {
  id: string;
  label: string;
  defaultBody: string;
  data: ArrayBuffer;
}

async function dbAll(): Promise<StoredModel[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredModel[]);
    req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
  });
}

async function dbPut(m: StoredModel): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(m);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
  });
}

async function dbDelete(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
  });
}

export class Catalog {
  entries: ModelEntry[] = [HUMAN];
  private readonly loader = new GLTFLoader();
  private humanKit: Promise<HumanKit> | null = null;
  private readonly templates = new Map<string, Promise<Template>>();
  private readonly importedData = new Map<string, ArrayBuffer>();

  async init(): Promise<string[]> {
    const warnings: string[] = [];
    try {
      const res = await fetch('models/manifest.json');
      if (res.ok) {
        const json = (await res.json()) as { models?: ManifestEntry[] };
        for (const m of json.models ?? []) {
          this.entries.push({
            id: m.id,
            label: m.label ?? m.id,
            description: m.description ?? '',
            defaultBody: m.defaultBody ?? 'adult_male',
            kind: 'gltf',
            url: `models/${m.file}`,
            boneMap: m.boneMap ?? {},
            source: m.source ?? '',
            imported: false,
          });
        }
      } else {
        warnings.push(`model manifest: HTTP ${res.status}`);
      }
    } catch (e) {
      warnings.push(`model manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      for (const m of await dbAll()) {
        this.importedData.set(m.id, m.data);
        this.entries.push({
          id: m.id, label: m.label, description: 'imported model', defaultBody: m.defaultBody,
          kind: 'gltf', url: null, boneMap: {}, source: 'imported', imported: true,
        });
      }
    } catch (e) {
      warnings.push(`imported models unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return warnings;
  }

  /** valid model names, including aliases */
  get ids(): string[] {
    return [...this.entries.map((e) => e.id), ...Object.keys(MODEL_ALIASES)];
  }

  get(id: string): ModelEntry | undefined {
    const real = MODEL_ALIASES[id] ?? id;
    return this.entries.find((e) => e.id === real);
  }

  defaultBodies(): Record<string, string> {
    const out: Record<string, string> = Object.fromEntries(this.entries.map((e) => [e.id, e.defaultBody]));
    for (const [alias, real] of Object.entries(MODEL_ALIASES)) {
      out[alias] = out[real] ?? 'adult_male';
    }
    return out;
  }

  private kit(url: string): Promise<HumanKit> {
    if (this.humanKit === null) {
      this.humanKit = HumanKit.load(url);
      this.humanKit.catch(() => {
        this.humanKit = null;
      });
    }
    return this.humanKit;
  }

  private template(entry: ModelEntry): Promise<Template> {
    let t = this.templates.get(entry.id);
    if (t === undefined) {
      t = this.loadTemplate(entry);
      this.templates.set(entry.id, t);
      t.catch(() => this.templates.delete(entry.id));
    }
    return t;
  }

  private async loadTemplate(entry: ModelEntry): Promise<Template> {
    let gltfScene: Object3D;
    if (entry.imported) {
      const data = this.importedData.get(entry.id);
      if (data === undefined) {
        throw new Error(`imported model ${entry.id} has no data`);
      }
      gltfScene = (await this.loader.parseAsync(data.slice(0), '')).scene;
    } else if (entry.url !== null) {
      gltfScene = (await this.loader.loadAsync(entry.url)).scene;
    } else {
      throw new Error(`model ${entry.id} has no source`);
    }
    const map = autoMapBones(gltfScene, entry.boneMap);
    const missing = missingRequired(map);
    if (missing.length > 0) {
      throw new Error(`could not find bones in ${entry.id}: ${missing.join(', ')}. Add a "boneMap" to models/manifest.json.`);
    }
    return { scene: gltfScene, map };
  }

  /** Create a fresh posable object for a figure. */
  async instantiate(id: string, body: BodyParams, material: Material): Promise<{ object: Object3D; map: BoneMap }> {
    const entry = this.get(id);
    if (entry === undefined) {
      throw new Error(`unknown model ${id}`);
    }
    if (entry.kind === 'human') {
      const kit = await this.kit(entry.url ?? 'models/makehuman');
      return kit.build(body, material);
    }
    const t = await this.template(entry);
    const object = cloneSkinned(t.scene);
    object.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh === true) {
        mesh.userData['originalMaterial'] = mesh.material;
        mesh.material = material;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    const wrapper = new Group();
    wrapper.add(object);
    return { object: wrapper, map: t.map };
  }

  /** Import a .glb file; returns the new entry or throws with a readable message. */
  async importFile(file: File): Promise<ModelEntry> {
    const data = await file.arrayBuffer();
    const gltf = await this.loader.parseAsync(data.slice(0), '');
    const map = autoMapBones(gltf.scene);
    const missing = missingRequired(map);
    if (missing.length > 0) {
      throw new Error(`"${file.name}" is not a recognizable humanoid rig (missing ${missing.join(', ')})`);
    }
    const box = new Box3().setFromObject(gltf.scene, true);
    if (box.isEmpty()) {
      throw new Error(`"${file.name}" has no visible geometry`);
    }
    let base = file.name.replace(/\.(glb|gltf)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(base)) {
      base = `model_${base}`;
    }
    let id = base;
    let n = 2;
    while (this.get(id) !== undefined) {
      id = `${base}_${n}`;
      n++;
    }
    const lower = file.name.toLowerCase();
    const defaultBody = /female|woman|girl|_f\b/.test(lower) ? 'adult_female' : 'adult_male';
    await dbPut({ id, label: file.name, defaultBody, data });
    this.importedData.set(id, data);
    const entry: ModelEntry = { id, label: file.name, description: 'imported model', defaultBody, kind: 'gltf', url: null, boneMap: {}, source: 'imported', imported: true };
    this.entries.push(entry);
    return entry;
  }

  async removeImported(id: string): Promise<void> {
    await dbDelete(id);
    this.importedData.delete(id);
    this.templates.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
  }
}
