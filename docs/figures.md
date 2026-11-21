# Figures and models

## The human figure

The default model, `human`, is built from MakeHuman data: the base mesh, its
morph targets, and the skeleton and skin weights of the "game engine" rig from
MPFB2, MakeHuman's plugin for Blender. MakeHuman is an established
open-source human figure system, and these assets are CC0. The model name
`mannequin` is accepted as another name for it, for compatibility with older
saved scenes.

Two scripts prepare the data:

```
node tools/fetch-makehuman.mjs    # CC0 source data into vendor/ (git-ignored)
node tools/build-makehuman.mjs    # writes public/models/makehuman/kit.json and kit.bin
```

The build script packs the data into a compact kit of about 6 MB. It
averages MakeHuman's three ethnic base shapes into a neutral one and stores
the morph targets quantized and sparse. The kit is CC0 and can be committed, so the scripts only need to run
again when `build-makehuman.mjs` changes.

`src/rig/makehuman.ts` builds a figure from the kit and a set of body
parameters:

- `femininity` (0 male, 1 female) sets gender, and `age` (years) blends the
  baby, child, young and old shapes;
- `build` sets weight (about 0.8 slim to 1.4 heavy) and `muscle` sets muscle
  (about 0.7 to 1.4);
- the ratio of the `bust` and `hip` circumferences (cm) sets cup size, faded
  out below puberty;
- `height` (meters) comes from scaling the rig;
- `heads` and `leg_length` deform the figure toward anime and chibi
  proportions. `heads` is the height in head lengths, and 0 keeps the natural
  proportion. `leg_length` scales the legs, and 1 keeps them natural.

After morphing, the joints are recomputed from the mesh, so the skeleton
always fits the body. The figure keeps only the vertices that are rendered;
MakeHuman's hidden auxiliary meshes are dropped, since they would distort the
figure's measured height. `waist` is part of the body parameters but not used
yet; MakeHuman's waist measurement targets would add it.

The human figure also carries the half-joint helper bones described in
[posing-and-contact.md](posing-and-contact.md).

## Body presets

Fourteen presets set all the parameters at once: `adult_male`,
`adult_female`, `teen_male`, `teen_female`, `child`, `athletic_male`,
`athletic_female`, `heavy_male`, `heavy_female`, `elderly`, `elderly_female`,
`anime_female`, `anime_male` and `chibi`. Any parameter can be changed on top
of a preset, with a slider in the Figure window or a command such as
`body amy age 40`. A crowd picks each member's preset from a built-in mix of
adult, heavy, elderly, athletic and teen bodies unless the command lists its
own (`add_crowd people bodies adult_female,child`), and varies each member's
height by up to 5% either way.

## Other models

- `xbot`, `michelle` and `soldier` are Mixamo-rigged models copied from the
  three.js examples into `public/models/`, kept for prototyping. They follow
  only the height parameter. Mixamo does not allow redistributing its raw
  files, so they have to be removed before the app is shipped.
- Any humanoid `.glb` can be dropped onto the app; it is kept in IndexedDB.
  Models can also be listed in `public/models/manifest.json`. Either way the
  bone mapper has to recognize the skeleton (see
  [posing-and-contact.md](posing-and-contact.md)).

MakeHuman was chosen as the base figure over these options, looked at on
2026-11-19:

- **Quaternius Universal Base Characters**: the Quaternius Asset License v1.0
  forbids redistributing the files on their own, and they are only available
  through an itch.io checkout.
- **Blender Studio Human Base Meshes**: CC0, but not rigged, and exporting
  them needs Blender.
- **NAVER Anny**: based on MakeHuman, under Apache and CC0 terms. A good
  future option for more body controls, but it is Python-only and has no glTF
  export.
