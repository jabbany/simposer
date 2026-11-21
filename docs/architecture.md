# Architecture

Simposer turns a description in natural language into a scene of posed 3D
figures that an artist can draw from. A request goes through these steps:

```
[natural language] --LLM--> [delta DSL] --apply--> [scene document] --solve + render--> [picture]
```

The language model is the only step that can give different answers for the
same input. The others are deterministic: applying the same delta to the same
scene always gives the same scene, and a scene always renders the same pose.
The two text formats in between, the delta DSL and the scene DSL, are meant to
be read and edited by people as well as by the model.

The rest of this document describes the steps in order, then the modules that
implement them. The topic documents go deeper:

- [pose-system.md](pose-system.md): the pose language and its default library.
- [posing-and-contact.md](posing-and-contact.md): how a pose becomes bone
  rotations on any rig, and how figures meet the ground.
- [figures.md](figures.md): the human figure, body parameters and other models.
- [interface.md](interface.md): the HUD (the in-picture interface), controls
  and camera diagram.
- [llm.md](llm.md): language model providers and translation.
- [dsl-reference.md](dsl-reference.md): the complete command and pose
  reference, written to be given to a language model.

## Natural language to delta

`src/llm/translate.ts` sends the request to a language model with:

- a system prompt that lists every command, joint, body part, pose and pose
  part (`src/llm/prompt.ts`). The prompt is generated from the same tables the
  parser uses, so it cannot describe syntax the parser rejects;
- the current scene as scene text;
- the last three requests and the deltas they produced, so the model can
  resolve "make her look at him".

The reply must be delta DSL. Each reply is parsed and applied to a copy of the
scene. If that fails, the error messages go back to the model and it gets
another try, up to two repairs. [llm.md](llm.md) covers the providers and the
measured behaviour of local models.

No model is needed to use the app. Text typed into the chat is first tried as
DSL: if every line parses and applies, it is applied without a model. Edits
made with the mouse or sliders also produce DSL commands, which go through the
same applier and into the undo history. The Scene window holds example
scripts.

## Delta DSL

A delta is a list of high-level commands, one per line. Angles are absolute:
`facing 0` faces +Z, toward the default camera, which stands 6 m out on +Z
looking back at the origin.

```
add runner model human body teen_female at 0 0 facing 0 pose run(phase = 0.3)
add_crowd passersby count 9 around runner radius 5 pose walk facing 180 seed 7
reach runner right_hand to self.face
camera orbit runner azimuth 160 elevation -10 distance 3
```

Commands name things a person would name: figures, body parts, poses, joint
motions in degrees ("left_elbow bend 100"), props and camera settings. Vertex
positions and raw bone rotations never appear in it. In a command about a
figure, `self.face` means that figure's own face.

`src/dsl/commands.ts` parses a delta into command objects and never throws: it
collects one error per bad line. `src/dsl/apply.ts` applies the commands to a
copy of the scene document. Application is atomic: if any command fails, the
whole delta is rejected and the scene is unchanged. That is what makes the
repair loop safe and undo simple.

## Scene document and scene DSL

The scene document (`src/dsl/types.ts`) holds the title, ground, render
style, light, camera, props, figures and any pose definitions the scene adds.
A figure stores its model, body type and body overrides, position and facing,
a pose expression (`walk(phase = 0.3)`), and the edits made on top of the
pose: joint angles given with the `set` command (`set amy head nod_down 20`),
reaches, a look target and hand shapes.

The scene DSL (`src/dsl/sceneText.ts`) is the document written out as text.
It is defined as "the delta script that rebuilds this scene from an empty
one", grouped into blocks for reading:

```
camera
  position 2.73 1.83 5.86
  look_at runner
  lens 35mm

figure runner
  model human
  body teen_female
  at 0 0
  facing 0
  pose run(phase = 0.3)
  reach right_hand to self.face
```

To parse scene text, each block line is rewritten into a delta command and run
through the delta parser and applier. The two languages therefore cannot drift
apart. Serialization is canonical (fixed key order and number formatting), so
serializing, parsing and serializing again gives the same text. The Scene
window in the app shows and edits this text, and the app saves it to
`localStorage` after each change.

Relations stay symbolic in the scene: `facing toward camera`,
`look at runner.face` and `reach right_hand to bob.hand` are resolved when the
scene is rendered, so they keep holding when figures move. Placement
relations such as `left_of` and `behind` are resolved to coordinates when the
command is applied.

## Poses

A figure's pose is an expression in the pose language
([pose-system.md](pose-system.md)). It is evaluated against a library: the
default recipes in `src/pose/lang/library.ts`, plus whatever the scene defines
with `define pose`. Evaluation yields joint angles, finger curls, reach goals
and the parts that carry the body (supports). The figure's own edits are then
laid over the result.

## Solving and rendering

`src/render/viewport.ts` owns the three.js scene. For each figure it:

1. evaluates the pose and applies the figure's edits;
2. works out what the figure stands or sits on (the floor, a box or step under
   it, or a chair when the pose sits);
3. runs the solver (`src/pose/solve.ts`), which turns angles, reaches and
   supports into bone rotations and a body position;
4. applies the result to the rig, measures the deformed skin against the
   ground and repeats a few times for exact contact (`src/rig/posing.ts`).

[posing-and-contact.md](posing-and-contact.md) describes steps 2 to 4.
Rendering uses dual quaternion skinning, shadow maps, an optional depth of
field pass and the `smooth`, `flat` and `toon` styles.

## Undo and history

Every change to the scene, whatever its source, is recorded in
`src/app/history.ts` as the delta that made it, with the documents before and
after. The sources are natural-language requests, typed DSL, interface edits,
camera moves, scene-text edits and example scripts. The interface tags
continuous edits with a key, such as the slider and figure being changed; an
entry with the same key as the one before it merges into it, so dragging a
slider or walking the camera makes one undo step. The chat log shows the
delta of each request.

## Modules

```
src/dsl/        vocabulary, tokenizer, delta parser, applier, scene text
src/pose/lang/  pose language: syntax, channels, evaluation, default library
src/pose/       landmarks (named body points) and the solver
src/rig/        canonical skeleton, bone-name mapping, rig normalization,
                MakeHuman figure, model catalog, contact correction
src/render/     viewport, camera controller, materials, skinning, ground and props
src/llm/        provider interface and implementations, prompt, translation loop
src/app/        app controller, undo history, example scripts
src/ui/         HUD (modes, hotkeys, windows), camera rig diagram, DOM helpers
tools/          scripts that fetch and pack the MakeHuman data
public/         PWA manifest, service worker, icons, models
```

`src/dsl/vocab.ts` holds the shared vocabulary: joints and their motions, body
parts, effectors (the hands and feet that `reach` can place), hand shapes, body presets, props and render styles. The
parser, the interface labels and the language model prompt are all generated
from it, so adding a word there makes it available everywhere.

## Offline use

The app is a progressive web app (PWA). In production builds a service worker
caches the app shell (the page, its manifest and `models/manifest.json`) when it
installs, and other files, models included, the first time they are
fetched. Pages are fetched network-first so updates arrive; everything else is
served from the cache first. Requests to other origins, such as language model
APIs, bypass it. The human figure loads from a compact kit, a pair of files
generated from CC0 MakeHuman data (see [figures.md](figures.md)).
A `.glb` model dropped onto the app is kept in IndexedDB (see
[figures.md](figures.md)).
