// System prompt for natural language -> delta DSL translation. Generated from
// the vocabulary tables so it never drifts from what the parser accepts.
// Kept compact on purpose: the goal is for small local models to manage it.

import { COMMAND_WORDS } from '../dsl/commands.ts';
import { BODY_PRESETS, EFFECTORS, GROUND_KINDS, HAND_SHAPES, JOINTS, PARTS, PROP_KINDS, RENDER_STYLES } from '../dsl/vocab.ts';
import { libraryFor, partsByRegion, poseSignature, wholeBodyPoses } from '../pose/lang/library.ts';
import { COMBINATORS, JOINT_ATOMS } from '../pose/lang/evaluate.ts';

/** Poses, slot parts and atoms, generated from the default library. */
function poseSection(): string {
  const lib = libraryFor([]);
  const poses = wholeBodyPoses(lib).map(poseSignature).join(', ');
  const parts = [...partsByRegion(lib)]
    .filter(([region]) => region !== 'all')
    .map(([region, defs]) => `  ${region}: ${defs.map(poseSignature).join(', ')}`)
    .join('\n');
  const joints = Object.keys(JOINT_ATOMS).join('/');
  return `POSES (whole body; "phase" is 0..1 in a stride): ${poses}
POSE PARTS, to fill a slot of the same name (arms, feet, legs, position):
${parts}
A pose is a name, or a name with arguments: walk(phase = 0.3, arms = phone_arms), stand(feet = tiptoe_feet), ballet(position = ballet_second, plie = 0.5).
To make a new reusable pose (only when asked to define or name one), list atoms or poses, each setting different joints:
define pose <name>(<param> = <default>, <slot>: <region> = <pose>) "<description>"
  <pose or atom>
  ...
end
ATOMS: ${joints}(<side>, <motion> = <deg>, ...) with sides left|right|both (hips/torso/head take no side); hand(<side>, <shape>); foot_roll(<side>, roll = -1 heel..0 flat..1 ball); reach(<effector>, <part>); support(<feet|knees|hands|seat|back|front>); lift(<m>); rest(<region>); ${Object.keys(COMBINATORS).map((c) => `${c}(...)`).join('; ')}`;
}

export interface ModelInfo {
  id: string;
  description: string;
}

export function buildSystemPrompt(models: ModelInfo[]): string {
  const joints = JOINTS.filter((j) => !j.name.startsWith('right_'))
    .map((j) => {
      const name = j.name.startsWith('left_') ? j.name.replace('left_', '(left|right)_') : j.name;
      return `  ${name}: ${j.dofs.map((d) => `${d.name} [${d.min}..${d.max}]`).join(', ')}`;
    })
    .join('\n');
  const parts = [...new Set(PARTS.map((p) => p.name.replace(/^(left|right)_/, '(left|right)_')))].join(', ');
  return `You translate a user's description of a drawing-reference scene into SceneDelta commands.
Output ONLY commands, one per line, inside a single \`\`\`dsl code block. Lines starting with # are comments.
The current scene is given in SceneText form; refer to existing figures by their names.
Make the smallest set of commands that achieves the request. Never invent commands.

COORDINATES: meters. Ground is the x/z plane, y is up. facing is degrees: 0 faces +z (toward the default camera), 90 faces +x, 180 faces -z.
A figure's own left/right are used for limbs and for left_of/right_of placement.

COMMANDS
title "<text>"
add <name> [model <model>] [body <body>] [height <m>] [at <x> <z> | <relation> <target> [distance <m>]] [facing <facing>] [pose <pose>]
add_crowd <group> count <n> [models <m1,m2>] [bodies <b1,b2>] [around <target> | at <x> <z>] [radius <m>] [pose <pose>] [facing <facing>|random] [seed <n>]
prop <name> <${PROP_KINDS.join('|')}> [at <x> <z> | <relation> <target> [distance <m>]] [facing <deg>] [size <w> <h> <d>]
remove <sel> | rename <old> <new> | model <sel> <model> | body <sel> <body> [<param> <value>...] | height <sel> <m>
place <sel> at <x> <z> | place <sel> <relation> <target> [distance <m>]
move <sel> <forward|back|left|right> <m> | turn <sel> <left|right> <deg> | face <sel> <facing> | elevate <sel> <m>
pose <sel> <pose>                         # resets joints, reaches, look and hands
phase <sel> <0..1>                        # moment in a walk/run cycle, keeps other adjustments
define pose ... end | undefine pose <name>   # see POSES below
set <sel> <joint> <motion> <deg>          # absolute angle, e.g. set amy left_elbow bend 90 / set amy head turn_right 30
adjust <sel> <joint> <motion> <deg>       # relative change
reach <sel> <${EFFECTORS.join('|')}> to <target>   # IK: put a hand/foot on something
release <sel> <effector|all>
look <sel> at <target> | look <sel> forward
hand <sel> <left|right|both> <${HAND_SHAPES.join('|')}>
reset <sel> [all|joints|reaches|look|hands|<joint>]
camera position <x> <y> <z> | camera look_at <target> | camera angles <yaw> <pitch>
camera orbit <target> [distance <m>] [azimuth <deg>] [elevation <deg>]   # azimuth is relative to the target figure: 0 = in front, 180 = behind, 90 = its left side
camera lens <mm> | camera aperture f/<n> | camera focus <target|meters|auto> | camera dof <on|off> | camera roll <deg> | camera frame <w:h|free>
light azimuth <deg> elevation <deg> [intensity <n>] [fill <n>]
ground <${GROUND_KINDS.join('|')}> | style <${RENDER_STYLES.join('|')}>

<sel>: a name, a comma list (a,b), @group (all crowd members), or * (everyone)
<target>: name.part (e.g. amy.face, self.left_hip), a figure name, a prop name, camera, or point <x> <y> <z>
<facing>: <deg> | toward <target> | away_from <target>
<relation>: left_of, right_of, in_front_of, behind, near

MODELS: ${models.map((m) => `${m.id} (${m.description})`).join('; ')}
BODIES: ${BODY_PRESETS.map((b) => `${b.name} (${b.description})`).join('; ')}
BODY PARAMS (human model): height m, age years, femininity 0..1 (0 male, 1 female), build 0.8..1.4 (weight), muscle 0.7..1.4, bust/hip cm, heads (0 natural, 6.5 anime, 3 chibi), leg_length
${poseSection()}
JOINTS and motions (degrees, negative = opposite):
${joints}
BODY PARTS: ${parts}

RULES
- Output commands only, no explanations. Replace every <placeholder> with a concrete value.
- Use names that describe the figure (runner, mother, guard). Lowercase, underscores.
- Prefer a pose, filling its slots with pose parts (walk(arms = phone_arms)), then refine with set/reach/look. Walking/running legs come from the pose; do not set leg angles for them.
- When a hand touches, covers, holds or points at a body part or object, use reach (e.g. reach amy right_hand to self.face), not joint angles.
- For people moving in a direction, set facing to that direction. Crowds go around the main figure, not the camera.
- Leave the camera alone unless asked about framing, angle, lens, or focus.

EXAMPLES
User: an old man standing still while commuters hurry past him in both directions
\`\`\`dsl
add old_man model human body elderly at 0 0 facing 0 pose stand
add_crowd commuters count 8 around old_man radius 4 pose walk facing random
\`\`\`
User: a woman sitting on a bench reading her phone
\`\`\`dsl
prop bench bench at 0 0
add reader model human body adult_female at 0 -0.05 facing 0 pose sit_chair
reach reader right_hand to self.chest
set reader head nod_down 35
hand reader right grip
\`\`\`
User: make her look at the camera and wave with her left hand
\`\`\`dsl
look reader at camera
set reader left_arm raise_sideways 80
set reader left_arm twist_out 90
set reader left_elbow bend 105
hand reader left open
\`\`\`
User: low angle shot from behind her, 85mm, shallow depth of field
\`\`\`dsl
camera orbit reader azimuth 160 elevation -10 distance 3
camera lens 85mm
camera aperture f/1.8
camera focus reader.face
\`\`\``;
}

export function buildUserMessage(sceneText: string, request: string): string {
  return `Current scene:\n\`\`\`\n${sceneText.trim()}\n\`\`\`\n\nRequest: ${request.trim()}`;
}

export function buildRepairMessage(errors: string[]): string {
  return `Those commands failed:\n${errors.map((e) => `- ${e}`).join('\n')}\nReply with the full corrected command list in one \`\`\`dsl block.`;
}

/**
 * Pull the DSL out of a model reply. Prefers the last fenced block; otherwise
 * keeps only lines that start with a command word, so prose that small models
 * mix into their answers is dropped before validation.
 */
export function extractDsl(reply: string): string {
  const fences = [...reply.matchAll(/```(?:dsl|text|plaintext)?\s*\n([\s\S]*?)```/gi)];
  const last = fences[fences.length - 1];
  const fenced = last !== undefined && last[1] !== undefined;
  const body = fenced ? (last[1] ?? '') : reply;
  // pose definitions keep their body lines, which do not start with a
  // command word, up to "end"
  let inDefine = false;
  return body
    .split(/\r?\n/)
    .map((l) => (inDefine ? l : l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')).replace(/`/g, '').trimEnd())
    .filter((l) => {
      const first = l.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (inDefine) {
        if (first === 'end') {
          inDefine = false;
        }
        return true;
      }
      if (first === 'define' && !/=/.test(l.replace(/\([^)]*\)/g, ''))) {
        inDefine = true;
      }
      return first.startsWith('#') || COMMAND_WORDS.has(first) || (fenced && first.length === 0);
    })
    .join('\n')
    .trim();
}
