# Pose system

A pose in Simposer is an expression in a small language, built from parts.
`walk(phase = 0.3)` is a pose; so is
`walk(phase = 0.3, arms = phone_arms, feet = tiptoe_feet)`, which keeps the
walking legs, holds a phone and walks on tiptoes. Scenes can use the poses in
the default library, redefine them, or define new ones with `define pose`.

The code is in `src/pose/lang/`:

| File | Contents |
| --- | --- |
| `ast.ts` | parser, `define` blocks, canonical printing |
| `channels.ts` | channels, regions, neutral values, mirroring, hand shapes, foot roll |
| `evaluate.ts` | atoms, composites, slots, blend, mix and mirror |
| `library.ts` | the default library, written in the language |
| `compose.ts` | turns an evaluated pose into solver input |

## Motivation

A pose stored as one table of joint angles can only be used whole. Building
poses from parts lets a new pose reuse what an existing one does with each
part of the body: "standing on tiptoes" is standing legs with the feet of a
tiptoe pose, and "skating" is a stride with gliding feet. It also gives a
language model a small vocabulary to work with: it picks parts for regions of
the body rather than writing angles. The ideas come from game engines,
animation tools and recent research; see [Prior art](#prior-art) at the end.

## Channels and regions

A pose produces values for named **channels**:

- joint motions in degrees, using the names of the DSL vocabulary:
  `left_knee.bend`, `torso.twist_left`, `left_ankle.roll_in`,
  `left_toes.bend_up`;
- finger curls, three joints per finger: `left_index.curl1` to `curl3`;
- the roll of each foot on the floor: `left_foot.roll`;
- support weights for the parts that carry the body: `support.left_foot`,
  `support.seat`, `support.back`, and so on. A part carries the body when its
  weight is above 0; the weight is 1 unless given (`support(seat, weight =
  0.5)`), and values between 0 and 1 are not used for anything else yet;
- `body.lift`, the height of an airborne body above its supports.

Reach goals (a hand or foot placed on a body part) are kept beside the
channels. For the conflict rule of composites (below) they count as channels
named `goal.left_hand` and so on.

A channel that no pose sets takes its neutral value: no rotation, no support
and no lift, except for the fingers, which rest in the `relaxed` hand shape.

Channels belong to **regions**. A region limits what a slot (a parameter that
takes a pose, described below) accepts, and error messages name regions.
The regions are `pelvis`, `torso`, `head`, `left_arm`, `right_arm`, `arms`,
`left_hand`, `right_hand`, `hands`, `left_leg`, `right_leg`, `legs`,
`left_foot`, `right_foot`, `feet`, `body`, `upper`, `lower` and `all`. An arm
region includes its hand and its reach goal. A leg region includes the hip
and knee and the foot's reach goal. A foot region holds the ankle, the toes,
the roll and that foot's support. `body` holds the other supports and the
lift. `upper` is the torso, head and both arms; `lower` is the pelvis, legs
and feet.

## The three kinds of pose

**Atoms** set channels directly. They are the only poses implemented in code;
every other pose, the default library included, is written in the language.
An atom sets only the motions it is given: `ankle(left, turn_out = 20)`
sets `left_ankle.turn_out` and leaves `left_ankle.point` to other poses.

| Atom | Sets |
| --- | --- |
| `hips(turn_left, bend_forward, lean_left)` | the pelvis |
| `torso(bend_forward, lean_left, twist_left)` | the spine, spread over its bones |
| `head(nod_down, tilt_left, turn_left)` | neck and head |
| `arm(side, raise_forward, raise_sideways, twist_out)` | the shoulder |
| `elbow(side, bend)` | the elbow |
| `wrist(side, bend, bend_thumb_side, turn_palm_forward)` | the wrist and forearm twist |
| `leg(side, raise_forward, raise_sideways, twist_out)` | the hip joint |
| `knee(side, bend)` | the knee |
| `ankle(side, point, turn_out, roll_in)` | the ankle |
| `toes(side, bend_up)` | the toes, bending at the ball of the foot |
| `hand(side, shape)` | finger curls for a named shape: `relaxed`, `open`, `fist`, `point`, `grip`, `flat` |
| `foot_roll(side, roll)` | ankle and toe angles and the foot's roll on the floor (see Foot roll) |
| `foot_contact(side, roll)` | only the foot's roll on the floor |
| `reach(effector, part)` | puts a hand or foot on a body part of the same figure; `none` releases it |
| `support(part, ...)` | what carries the body: `feet`, `knees`, `hands`, `seat`, `back`, `front`, or one side such as `left_knee` |
| `lift(height)` | lifts the body above its supports, in meters |
| `rest(region)` | every channel of a region at its neutral value |

`side` is `left`, `right` or `both`. Motion arguments accept the DSL aliases
listed in [dsl-reference.md](dsl-reference.md), with the sign they carry: `arm(left, swing_back = 20)` is
`arm(left, raise_forward = -20)`.

**Composites** are named poses made of lines. Each line is an atom, another
pose or a blend. Two lines may not set the same channel: if they do, the
definition is rejected with an error that names the channel and both lines.
A line marked `override` is the exception; it may replace channels set by
lines above it. This keeps the parts of a pose responsible for separate parts
of the body, which is what lets a slot be filled without surprises.

A composite can leave **slots** open. A slot is a parameter that takes a pose,
limited to a region, with a default. In the example below,
`arms: arms = relaxed_arms` declares a slot named `arms` for the `arms`
region, filled with `relaxed_arms` unless the caller passes another pose, and
the line `$arms` inserts whatever pose fills it:

```
define pose stand(arms: arms = relaxed_arms, feet: feet = flat_feet) "relaxed standing, arms at sides"
  relaxed_stance(feet = $feet)
  $arms
end
```

A pose passed into a slot may only set channels of that region.
`stand(arms = stance)` is an error, because `stance` sets the legs.

**Interpolations** combine whole poses channel by channel:

- `blend(a, b, t)` goes from `a` at `t = 0` to `b` at `t = 1`. Values of `t`
  outside 0 to 1 extrapolate, so `blend(stand, cheer, 1.3)` exaggerates the
  cheer.
- `mix(a, wa, b, wb, ...)` is a weighted average of any number of poses. The
  weights need not add up to 1: each channel is divided by the total weight
  of the poses that set it.
- `mirror(pose)` swaps left and right, and negates the sideways motions of the
  pelvis, spine and head (`turn_left`, `lean_left`, `twist_left`,
  `tilt_left`).

When only one pose in a blend sets a channel, the blend keeps that pose's
value. A blend reaches a neutral value only if a pose sets it, for example
with `rest(arms)`: `blend(cheer, rest(arms), 0.5)` lowers the arms halfway,
while `blend(cheer, stand, 0.5)` blends toward the standing arms. Reach goals
blend by weight, under the same rule: a reach set by only one pose is kept
whole. A hand reaching for the chin, blended at 0.5 with
`reach(right_hand, none)`, moves halfway from where the arm's angles put it
toward the chin.

A one-line definition names a blend or a filled pose and gives its parameters:

```
define pose jog(phase = 0, speed = 0.5) "between a walk and a run"
  = blend(walk(phase = $phase), run(phase = $phase), $speed)
```

## Syntax

```
define pose NAME [( PARAM, ... )] ["description"]
  [override] EXPR
  ...
end

define pose NAME [( PARAM, ... )] ["description"] = EXPR

PARAM := NAME [: REGION] [= EXPR]
EXPR  := NUMBER | WORD | $NAME
       | NAME ( [ARG, ...] )
       | EXPR + EXPR | EXPR - EXPR | EXPR * EXPR | EXPR / EXPR | -EXPR | ( EXPR )
ARG   := [NAME =] EXPR
```

Arithmetic works on numbers only. A word is a pose name, a side, a hand
shape, a body part or a region, depending on where it is used. `$name` reads a parameter. Parameters without
a default must be given; positional arguments fill parameters in order.

Numeric functions: `sin`, `cos` (radians), `sin1`, `cos1` (one period per
1.0), `abs`, `frac`, `pow`, `min`, `max`, `clamp(x, lo, hi)`,
`lerp(a, b, t)`, `smoothstep(a, b, x)` and `cycle(phase, k0, k1, ...)`. The
constants are `pi` and `tau`. `cycle` reads evenly spaced keys over one cycle
as a smooth periodic curve (Catmull-Rom); the gaits use it for joint-angle
tables sampled every 5% of a stride.

A definition's header, and any line inside parentheses, can continue over
several lines. The description and a one-line definition's `= EXPR` may also
start on the next line.

In the scene and delta DSL:

- `pose amy stand(feet = tiptoe_feet)` sets a figure's pose.
  `pose amy walk phase 0.3` is a shorthand for `walk(phase = 0.3)`.
- `phase amy 0.4` changes only the phase argument.
- `define pose ... end` adds or replaces a definition in the scene, and
  `undefine pose NAME` removes it, restoring the library version if there is
  one.
- The scene text prints the scene's own definitions before its figures.

The applier checks every definition when it is made: the names of atoms,
functions and keywords are reserved, a definition whose parameters all have
defaults must evaluate, and
every figure must still evaluate under the new library. Removing a definition
that a figure or another definition uses is refused.

## Supports and grounding

A pose states what carries the body; the solver puts those parts on the
support surface. The solver grounds a figure in one of three ways (on its
feet, on its seat, or on its lowest point), and `compose.ts` chooses from the
supports:

| Supports | Grounding |
| --- | --- |
| seat and feet | sits on a chair, bench, box or step under the figure (a table only if there is nothing else); stands if there is none |
| seat only | sits on the floor |
| knees, hands, back or front | the lowest body point rests on the floor, and the feet are laid on it (see "Resting limbs" in [posing-and-contact.md](posing-and-contact.md)) |
| feet only | stands; each foot is planted according to its height above the floor ([posing-and-contact.md](posing-and-contact.md)) |

Hands, knees, back and front are not planted one by one. A plank rests on its
lowest points, which are the hands and the feet.

## Foot roll

`foot_roll(side, roll)` describes how a foot meets the floor:

| roll | Foot |
| --- | --- |
| -1 | on the heel, toes up 25 degrees |
| 0 | flat |
| 1 | high on the ball: heel up 45 degrees, toes bent 45 degrees so they stay flat |
| 2 | on the tips: heel up 70 degrees, toes bent 20 degrees |

Values in between are interpolated. The roll describes the foot against the
floor, while ankle angles are measured against the shin. The atom sets the
ankle and toe angles that give that roll when the shin is vertical, as in
standing, and records the roll itself. When the shin leans, as in a stride,
the solver turns a standing foot so that the sole meets the floor at the
roll's angle, and lays the toes flat. `foot_contact` records only the roll; the gaits use it so
that the ankle angle in the air can follow gait data.
[posing-and-contact.md](posing-and-contact.md) describes how the solver plants
the foot.

## The default library

`library.ts` holds the default recipes as text in the language. They fall into
three groups.

**Building blocks**, used to fill slots:

- feet: `flat_feet`, `tiptoe_feet(height)`, `heel_feet`, and the feet of the
  strides, `walk_feet`, `run_feet`, `sprint_feet`, `high_heel_feet`,
  `skate_feet`;
- arms: `relaxed_arms`, `crossed_arms`, `fists_on_hips`, `phone_arms`,
  `wave_arms`, `arm_swing(phase)`, `ballet_arms_low`, and one-arm parts such
  as `point_arm(side)` and `wave_arm(side)`;
- legs: `stance(spread)`, `relaxed_stance`, one leg of a stride
  (`walk_leg(side, phase)`, `run_leg`, `sprint_leg`), and the ballet
  positions `ballet_first`, `ballet_second`, `ballet_fifth`;
- whole strides: `stride_turn(phase)` (the pelvis and chest turning with a
  stride), `flight(phase)` (the lift of a run), and `gait(phase)`, a simpler
  stride whose leg angles follow sine curves.

**Whole poses**:

- standing: `stand`, `attention`, `tpose`, `apose`, `point`, `wave`,
  `arms_crossed`, `hands_on_hips`, `thinking`, `cover_face`, `fight_stance`,
  `cheer`, `phone`, `carry_bag`;
- moving: `walk`, `run`, `sprint`, `jump`;
- low: `crouch`, `squat`, `kneel`, `kneel_both`;
- sitting and lying: `sit_chair`, `sit_ground`, `sit_hug_knees`, `lie_back`,
  `lie_front`.

A pose counts as whole if it states a support and also sets something for the
arms, either an arm or hand motion or a hand reach. The interface's pose list
and the model prompt show only whole poses.

**Poses made by filling slots or blending** other poses: `tiptoe`,
`sneak` (a walk on the balls of the feet), `heel_walk`, `high_heels_walk`,
`skate_stride`, `walk_phone`, `tiptoe_wave`, `plank`,
`ballet(position, plie, releve, arms)`, `jog` (a blend of walk and run by
speed), `half_crouch(depth)` and `exaggerated_cheer(amount)`.

Pose names also accept a few words of natural phrasing: `walking` is `walk`,
`sitting` is `sit_chair`, `lying` is `lie_back`.

### Gaits

Walk, run and sprint come from joint-angle tables measured in gait studies.
Each table covers one stride, sampled every 5% from the leg's own foot
strike, and gives hip flexion, knee flexion and ankle dorsiflexion. The
walking table follows normal gait data (Perry; Winter): the stance phase takes about 60% of the
cycle, the knee bends about 15 degrees as the foot takes the weight and about
40 degrees by toe-off, and about 60 in the swing. The running and sprinting
tables follow running kinematics, with more flexion throughout and up to 95
and 125 degrees at the knee in the swing.

Other parts of the gaits:

- `phase` 0 is the left foot strike, and the right leg runs half a cycle
  behind.
- `stride_turn` turns the pelvis with the stride and the chest against it. It
  also turns the legs back at the hips, so a planted foot keeps its heading,
  and tilts the pelvis forward about 10 degrees, because gait data measures
  hip angles against a pelvis tilted that way.
- The legs angle inward 4 to 5 degrees (the `inward` parameter of the stride
  legs), which puts the feet about 10 cm apart, as in walking, rather than
  straight under the hip joints.
- The foot's roll follows the stride: a heel strike with the toes up, a flat
  foot, the heel rising onto the ball, toe-off. Running strikes lightly on the
  heel and the sprint lands on the forefoot.
- The `flight` part of `run` and `sprint` lifts the body after each toe-off,
  so both feet leave the ground.

Every table, timing and amplitude is part of a recipe, so a scene can redefine
any of them.

## Status and limits

- There is no `look` atom yet. A figure's gaze is set with the `look` command.
- Hands, knees, back and front are not planted one by one (see Supports and
  grounding).
- `skate_stride` is built on `gait` and reads more like a crouched walk than a
  skating push.
- In the walk, both feet are on the ground for about 5% of the cycle around
  each heel strike. In real walking it is about 12%.
- The app has no interface for editing pose definitions yet. They are edited
  as text in the Scene window or written by the language model.

Poses considered when this system was designed and not built yet, each of
which would test a different part of it:

- crawling on hands and knees, reusing the stride parts on the arms;
- sitting on the floor leaning back on the hands, and leaning on a wall with
  a hand reaching the wall prop (both need supports beyond the feet);
- the yoga tree pose and warrior II, and a football kick with a wind-up
  parameter;
- contrapposto as a blend from even standing to the weight on one leg;
- in-betweens: blends between two of the user's own poses, for drawing a
  sequence of frames.

## Prior art

| Idea | Source |
| --- | --- |
| A pose writes only some of the rig's channels, grouped into body regions | Per-bone and body-part masks: Unreal's Layered Blend per Bone and Blend Masks, Unity's Avatar Masks |
| A partial pose applied to part of the body | Blender's pose library, which applies a pose to the selected bones |
| A pose that mixes other poses by a parameter | Blend spaces and pose assets in Unreal |
| A weight above 1 exaggerates | Blender's pose blending, which can extrapolate |
| A small vocabulary of per-body-part poses that a language model can pick and edit | PoseScript posecodes, CoMo pose codes, SINC (an LLM maps actions to body parts), LaMoGen (an LLM writes per-body-part symbolic plans) |
| What carries the body is stated apart from what the free limbs do | Labanotation's support column and gesture columns |
| A foot rolls from heel to flat to ball to toe, bending at the ball | Foot-roll rigs with heel, ball and toe pivots; Perry's heel, ankle and forefoot rockers in gait analysis |

## References

- J. Perry, *Gait Analysis: Normal and Pathological Function*; D. A. Winter,
  *Biomechanics and Motor Control of Human Movement*. The walking table
  follows the normal joint-angle curves these describe.
- Unreal Engine: [Using layered animations](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-layered-animations-in-unreal-engine),
  [Blend masks and blend profiles](https://dev.epicgames.com/documentation/en-us/unreal-engine/blend-masks-and-blend-profiles-in-unreal-engine),
  [Blend spaces](https://dev.epicgames.com/documentation/unreal-engine/blend-spaces-in-unreal-engine?lang=en-US),
  [Animation pose assets](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-pose-assets-in-unreal-engine)
- Blender manual: [Pose Library](https://docs.blender.org/manual/en/dev/animation/armatures/posing/editing/pose_library.html)
- Delmas et al., PoseScript, ECCV 2022: <https://arxiv.org/abs/2210.11795>
- Huang et al., CoMo, ECCV 2024: <https://arxiv.org/abs/2403.13900>
- Athanasiou et al., SINC, ICCV 2023: <https://arxiv.org/abs/2304.10417>
- Jiang et al., LaMoGen, CVPR 2026: <https://arxiv.org/abs/2603.11605>
- Dance Notation Bureau, [Labanotation fundamentals](https://www.dancenotation.org/labanotation-fundamentals/)
- Gait rockers: [Rockers and rollovers (LER)](https://lermagazine.com/?p=17081)
- Normal gait: [Normal Gait (University of Missouri)](https://medicine.missouri.edu/sites/default/files/pm-r/Normal_Gait.pdf)
- Running: [Running Biomechanics (Physiopedia)](https://www.physio-pedia.com:443/Running_Biomechanics)
