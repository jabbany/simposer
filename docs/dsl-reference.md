# Simposer DSL reference

This document is the complete reference for the Simposer scene language. It is
written to be given to a language model that translates natural-language
requests into commands. Everything listed here is accepted by the parser;
anything not listed is rejected.

## 1. Your task and output format

- Translate the user's request into **delta commands**: one command per line,
  inside a single fenced code block marked `dsl`.
- Output commands only. Lines starting with `#` are comments.
- Make the smallest set of commands that achieves the request. Refer to
  existing figures, props and groups by the names used in the current scene.
- Replace every `<placeholder>` with a concrete value. Never invent commands,
  joints, motions, body parts, poses or keywords.
- All commands in one reply are applied together. If any line fails, none
  are applied and you receive the error messages to correct the reply. Send
  the full corrected list, not only the fixed lines.

## 2. Conventions

- **Units.** Distances in meters, angles in degrees. Numbers may carry units:
  `1.6`, `1.6m`, `160cm` (converted to 1.6), `35mm` (camera lens), `30deg`,
  `f/2.8` (aperture).
- **Ground and axes.** The ground is the x/z plane; y is up. `facing 0` faces
  +z, toward the default camera. `facing 90` faces +x. `facing 180` faces -z.
  Facings are normalized to the range -180 to 180.
- **Left and right** of a figure are its own left and right. They are used for
  limbs, for `left_of` and `right_of` placement, and for `turn_left`-style
  motions.
- **Names** are lowercase letters, digits and underscores, starting with a
  letter: `runner`, `old_man`, `chair_a`. Use names that describe the figure.
  Names are shared by figures and props; `camera`, `self`, `point` and
  `origin` are reserved.

### Selectors (`<sel>`)

Commands that act on figures take a selector:

| Selector | Meaning |
| --- | --- |
| `amy` | one figure (or, for `remove`, a prop) |
| `amy,bob` | several figures, comma-separated without spaces |
| `@passersby` | every member of a group (crowds are groups) |
| `*`, `all`, `everyone` | every figure |

### Targets (`<target>`)

| Target | Meaning |
| --- | --- |
| `amy.face` | a body part of a figure |
| `self.left_hip` | a body part of the figure the command is about |
| `amy` | a figure as a whole |
| `chair_a` | a prop |
| `camera` (or `viewer`) | the camera |
| `origin` (or `center`) | the point 0 0 0 |
| `point <x> <y> <z>` | a point in the scene |

### Facings (`<facing>`)

| Facing | Meaning |
| --- | --- |
| `<deg>` | an absolute angle (see above) |
| `toward <target>` | turned to face the target, and kept facing it when things move |
| `away_from <target>` | turned away from the target |
| `front`, `forward`, `camera_facing` | 0 |
| `back`, `backward`, `away` | 180 |
| `left` | 90 |
| `right` | -90 |

### Relations (`<relation>`)

`left_of`, `right_of`, `in_front_of` (also `front_of`, `ahead_of`), `behind`,
`near` (also `next_to`, `beside`). They are measured from the target's own
facing: `left_of amy` is on Amy's left. The default distance is 1.0 m (0.9 m
for `near`). Placement relations are turned into coordinates when the command
is applied.

## 3. Commands

### Scene

```
title "<text>"
ground <grid|plain|street>
style <smooth|flat|toon>              # flat: faceted planes; toon: three-tone shading
light [sun] [azimuth <deg>] [elevation <deg>] [intensity <n>] [fill <n>]
```

`light` changes only the values given. Elevation is clamped to 2..90,
intensity to 0..10, fill (ambient light) to 0..2.

### Figures

```
add <name> [model <model>] [body <body>] [<body_param> <value> ...]
           [at <x> <z> | <relation> <target> [distance <m>]]
           [facing <facing>] [pose <pose>] [elevation <m>]
```

Attributes may come in any order. Defaults: model `human`, body `adult_male`,
position 0 0, facing toward the camera, pose `stand`. `elevation` stands the
figure on a raised surface (meters above the ground).

```
add_crowd <group> [count <n>] [models <m1,m2>] [bodies <b1,b2>]
                  [around <target> | at <x> <z>] [radius <m>]
                  [pose <pose>] [facing <facing> | facing random] [seed <n>]
```

Adds `count` figures (1 to 40, default 6) named `<group>_1`, `<group>_2`, ...
in the group `@<group>`, scattered within `radius` (default 5 m). With
`around <target>` they keep clear of the target. The default pose is `walk`.
Each member gets its own moment of a stride pose, a height within 5% of its
body preset, and a facing within 12 degrees of the one given. `seed` changes
the random layout. `crowd` and `add crowd` are the same command.

```
remove <sel>                          # also removes props by name
rename <old> [to] <new>
group <sel> <group | none>
model <sel> <model>
body <sel> [<body>] [<body_param> <value> ...]   # a new body preset clears earlier parameter changes
height <sel> <m>
place <sel> at <x> <z>
place <sel> <relation> <target> [distance <m>]
move <sel> <forward|back|left|right> <m>         # along the figure's own facing
move <sel> by <dx> <dz>
face <sel> <facing>
turn <sel> <left|right> <deg>
turn <sel> around
elevate <sel> <m>
```

### Poses and body edits

```
pose <sel> <pose>
phase <sel> <0..1>
set <sel> <joint> <motion> <deg>
adjust <sel> <joint> <motion> <deg>
reach <sel> <effector> [to|on|at|toward] <target>
release <sel> <effector | all>
look <sel> [at|toward] <target>
look <sel> forward
hand <sel> <left|right|both> <shape>
reset <sel> [all | joints | reaches | look | hands | <joint>]
```

- `pose` sets the figure's pose (see section 6). It also clears the figure's
  `set` angles, reaches, look target and hand shapes. `pose amy walk phase 0.3`
  is the same as `pose amy walk(phase = 0.3)`.
- `phase` changes only the moment in a stride pose (a pose with a `phase`
  parameter) and keeps everything else. Values wrap to 0..1.
- `set` gives a joint motion an absolute angle, on top of the pose. The value
  is clamped to the motion's range. The motion may be written as several
  words (`set amy head turn right 30`). For a joint with one motion it can be
  left out (`set amy left_knee 40`). Setting an arm or elbow removes that
  hand's reach; setting a leg or knee removes that foot's reach; setting the
  head removes the look target.
- `adjust` is `set` relative to the current angle.
- `reach` places a hand or foot on a target with inverse kinematics, and clears
  `set` angles on that limb (arm and elbow, or leg and knee). A hand placed on
  a body surface lies with its palm on the surface.
- `look` turns the head and neck toward a target and clears `set` angles on
  the head. A figure cannot look at itself; use `set <sel> head nod_down <deg>`
  to look down at one's own body.
- `hand` sets a hand shape on top of the pose.
- `reset` removes the figure's own edits and returns to the pose.

### Props

```
prop <name> <kind> [at <x> <z> | <relation> <target> [distance <m>]] [facing <deg>] [size <w> <h> <d>]
```

`add_prop` and `add prop` are the same command. Using an existing prop name
updates that prop. Kinds and default sizes (width x height x depth, meters):

| Kind | Size | Notes |
| --- | --- | --- |
| `box` | 0.5 x 0.5 x 0.5 | can be stood or sat on |
| `chair` | 0.48 x 0.9 x 0.5 | seat height 0.46 m |
| `bench` | 1.6 x 0.45 x 0.4 | |
| `table` | 1.2 x 0.75 x 0.8 | can be stood on; sat on only when nothing else is there |
| `wall` | 4 x 2.5 x 0.2 | |
| `pillar` | 0.4 x 3 x 0.4 | |
| `step` | 1.2 x 0.18 x 0.35 | can be stood or sat on |

A figure placed over a box, step or table stands on top of it. A figure with a
sitting pose (`sit_chair`) placed at a chair, bench, box or step sits on it.

### Camera

```
camera position <x> <y> <z>            # also: camera at <x> <y> <z>
camera height <y>
camera look_at <target>                # also: look, aim_at, target
camera angles <yaw> <pitch>            # also: aim
camera orbit <target> [distance <m>] [azimuth <deg>] [elevation <deg>]
camera lens <mm>                       # focal length on a 36x24 mm sensor, 8..600
camera aperture f/<n>                  # 0.95..32; also turns depth-of-field blur on
camera focus <target | meters | auto>  # also: focus on <target>
camera dof <on|off>                    # depth-of-field blur
camera roll <deg>                      # dutch angle
camera frame <W:H | free>              # framing guide, e.g. 3:2
```

`camera orbit` places the camera around a target and aims at it. `azimuth` is
measured from the target figure's facing: 0 is in front of it, 180 behind it,
90 on its left side. Without `distance`, the camera frames the subject.
Leave the camera alone unless the request is about framing, angle, lens or
focus.

### Pose definitions

```
define pose <name>[(<params>)] ["<description>"]
  [override] <pose expression>
  ...
end

define pose <name>[(<params>)] ["<description>"] = <pose expression>

undefine pose <name>
```

Section 6.6 explains definitions.

## 4. Figures and bodies

**Models**: `human` (the default; a realistic body that follows every body
parameter; `mannequin` is an alias), and `xbot`, `michelle`, `soldier`
(stylized prototype models that follow only `height`). The app may list
additional imported models.

**Body presets**:

| Body | Description |
| --- | --- |
| `adult_male` | average adult man, 1.76 m |
| `adult_female` | average adult woman, 1.63 m |
| `teen_male` | teenage boy, about 15, 1.68 m |
| `teen_female` | teenage girl, about 15, 1.60 m |
| `child` | child, about 8, 1.28 m |
| `athletic_male` | muscular athletic man, 1.82 m |
| `athletic_female` | fit athletic woman, 1.70 m |
| `heavy_male` | heavyset man, 1.75 m |
| `heavy_female` | heavyset woman, 1.62 m |
| `elderly` | older man around 75, 1.72 m |
| `elderly_female` | older woman around 75, 1.60 m |
| `anime_female` | stylized anime proportions: larger head, long legs |
| `anime_male` | stylized anime proportions: larger head, long legs |
| `chibi` | super-deformed cartoon, huge head, 1.0 m |

**Body parameters** (human model), given after a body in `add` or `body`:

| Parameter | Meaning |
| --- | --- |
| `height` | meters |
| `age` | years |
| `femininity` | 0 male to 1 female |
| `build` | weight, 0.8 (slim) to 1.4 (heavy) |
| `muscle` | 0.7 to 1.4 |
| `bust`, `hip` | circumference in cm |
| `waist` | circumference in cm (stored, not yet shown) |
| `heads` | height in head lengths: 0 natural, about 6.5 anime, 3 chibi |
| `leg_length` | leg length factor, 1 natural |

Example: `body amy adult_female age 60 build 1.2`.

## 5. Joints, motions, body parts

### 5.1 Joints and motions

Angles are degrees from the neutral standing pose (standing straight, arms
hanging, palms facing the thighs). A negative value moves the opposite way;
the aliases marked (-) mean the opposite direction, so `turn_right 20` is
`turn_left -20`. Every `left_` joint has a `right_` twin with the same
motions.

| Joint (aliases) | Motion [range] | Meaning | Aliases |
| --- | --- | --- | --- |
| `hips` (pelvis, waist) | `bend_forward` [-45..100] | tip the pelvis forward (negative = arch back) | bend, lean_forward; bend_back(-), arch(-), arch_back(-), lean_back(-) |
| | `lean_left` [-45..45] | side-bend to own left | tilt_left; lean_right(-), tilt_right(-) |
| | `turn_left` [-70..70] | turn toward own left | twist_left, rotate_left; turn_right(-), twist_right(-), rotate_right(-) |
| `torso` (spine, chest, upper_body, back, body) | `bend_forward` [-45..100] | bend the spine forward (negative = arch back) | as hips |
| | `lean_left` [-45..45] | side-bend to own left | as hips |
| | `twist_left` [-70..70] | twist toward own left | turn_left, rotate_left; twist_right(-), turn_right(-), rotate_right(-) |
| `head` (neck, face) | `nod_down` [-60..70] | tip the chin down (negative = look up) | nod, look_down, tilt_down, down; nod_up(-), look_up(-), tilt_up(-), tilt_back(-), up(-) |
| | `tilt_left` [-45..45] | tilt an ear toward the own left shoulder | cock_left; tilt_right(-), cock_right(-) |
| | `turn_left` [-85..85] | turn to look toward own left | look_left, left; turn_right(-), look_right(-), right(-) |
| `left_arm` (left_shoulder, left_upper_arm, left_upperarm) | `raise_forward` [-60..180] | raise the arm forward from hanging: 90 points ahead, 180 overhead (negative = swing back) | forward, raise_front; raise_back(-), swing_back(-), back(-) |
| | `raise_sideways` [-40..180] | raise the arm out to the side: 90 is a T-pose (negative = across the body) | sideways, raise_side, out, raise_out; across(-), in(-) |
| | `twist_out` [-90..90] | rotate the arm outward around its own axis | rotate_out, twist; twist_in(-), rotate_in(-) |
| `left_elbow` (left_forearm, left_lower_arm) | `bend` [0..150] | 0 straight, 150 fully bent | flex; straighten(-) |
| `left_wrist` (left_hand) | `bend` [-70..80] | bend the hand toward the palm (negative = toward the back of the hand) | flex, bend_in; bend_back(-), extend(-) |
| | `bend_thumb_side` [-30..30] | tilt the hand toward the thumb | side; bend_pinky_side(-) |
| | `turn_palm_forward` [-90..90] | rotate the forearm so the palm faces forward or up (negative = back or down) | palm_forward, palm_up, supinate, twist; turn_palm_back(-), palm_back(-), palm_down(-), pronate(-) |
| `left_leg` (left_hip, left_thigh, left_upper_leg) | `raise_forward` [-40..140] | raise the thigh forward: 90 is horizontal (negative = swing back) | forward, raise_knee, kick_forward; raise_back(-), swing_back(-), back(-), kick_back(-) |
| | `raise_sideways` [-30..90] | raise the leg out to the side (negative = across) | sideways, raise_side, out, spread; across(-), in(-) |
| | `twist_out` [-45..60] | rotate the leg so the toes point out | rotate_out, twist; twist_in(-), rotate_in(-) |
| `left_knee` (left_shin, left_lower_leg, left_calf) | `bend` [0..160] | 0 straight, 150 fully bent | flex; straighten(-) |
| `left_ankle` (left_foot) | `point` [-40..70] | point the toes down (negative = toes up) | point_down, toes_down; toes_up(-), flex(-) |
| | `turn_out` [-30..30] | turn the foot outward | turn_in(-) |
| | `roll_in` [-25..35] | roll the sole to face inward, onto the outer edge (negative = onto the inner edge) | invert; roll_out(-), evert(-) |
| `left_toes` (left_toe, left_ball) | `bend_up` [-40..70] | bend the toes up at the ball of the foot (negative = curl down) | lift, extend, bend; curl(-), bend_down(-) |

Example: `set amy left_elbow bend 90`, `set amy head turn_right 30`,
`adjust amy torso bend_forward 10`.

### 5.2 Body parts

Body parts are reach and look targets (`amy.chin`, `self.left_knee`):

- center: `head`, `top_of_head`, `face`, `forehead`, `eyes`, `mouth`, `chin`,
  `back_of_head`, `neck` (front of the neck), `chest`, `belly`, `back` (upper
  back), `lower_back`, `pelvis`;
- each side, with `left_` or `right_`: `eye`, `ear`, `cheek`, `shoulder`,
  `upper_arm`, `elbow`, `forearm`, `wrist`, `hand`, `hip`, `thigh`, `knee`,
  `shin`, `ankle`, `foot`, `heel`, `toes`.

Accepted synonyms: nose, cheek, cheeks -> face; lips -> mouth; jaw -> chin;
crown -> top_of_head; skull -> head; throat -> neck; breast, heart -> chest;
stomach, abdomen, tummy, waist -> belly; hips, groin -> pelvis; spine -> back;
butt -> lower_back; `<side>_palm`, `<side>_fingers`, `<side>_fist` ->
`<side>_hand`; `<side>_calf`, `<side>_lower_leg` -> `<side>_shin`;
`<side>_upper_leg` -> `<side>_thigh`; `<side>_toe`, `<side>_foot_tip` ->
`<side>_toes`.

### 5.3 Effectors and hand shapes

**Effectors** (what `reach` moves): `left_hand`, `right_hand`, `left_foot`,
`right_foot`. Also accepted: `<side>_palm`, `<side>_wrist`, `<side>_arm` for
the hand, and `<side>_leg` for the foot.

**Hand shapes**: `relaxed` (the default), `open`, `fist`, `point` (index
finger out), `grip` (holding something), `flat`.

## 6. The pose language

A pose is an expression. The simplest pose is a name: `stand`, `walk`,
`sit_chair`. Poses take arguments: `walk(phase = 0.3)`. Some arguments are
**slots** that take another pose for one body region:
`walk(phase = 0.3, arms = phone_arms)` walks while holding a phone, and
`stand(feet = tiptoe_feet)` stands on tiptoes.

### 6.1 Expressions

```
<pose name>                              stand
<pose name>(<arg>, <name> = <arg>, ...)  walk(phase = 0.3, arms = phone_arms)
<atom>(...)                              knee(left, bend = 40)
blend(<pose>, <pose>, <t>)               blend(walk, run, 0.5)
mix(<pose>, <w>, <pose>, <w>, ...)       mix(stand, 1, crouch, 2)
mirror(<pose>)                           mirror(wave)
```

Arguments are numbers, words (a pose name, a side, a hand shape, a body part,
a region) or pose expressions. Positional arguments fill parameters in order;
named arguments use `name = value`. Numbers may use `+ - * /`, parentheses,
`$param` inside definitions, the constants `pi` and `tau`, and the functions
`sin`, `cos` (radians), `sin1`, `cos1` (one period per 1.0), `abs`, `frac`,
`pow`, `min`, `max`, `clamp(x, lo, hi)`, `lerp(a, b, t)`,
`smoothstep(a, b, x)` and `cycle(phase, k0, k1, ...)` (a smooth periodic curve
through evenly spaced keys).

### 6.2 Whole-body poses

Use these with `pose`, `add ... pose` and `add_crowd ... pose`. `phase` is the
moment in a stride, 0 to 1; phase 0 is the left foot striking the ground.
Slots are marked `slot: region`.

| Pose | Parameters | Description |
| --- | --- | --- |
| `stand` | arms (slot: arms), feet (slot: feet) | relaxed standing, arms at sides |
| `attention` | feet (slot: feet) | straight upright standing |
| `tpose` | feet (slot: feet) | arms straight out to the sides |
| `apose` | feet (slot: feet) | arms angled down 45 degrees |
| `point` | | pointing ahead with the right arm |
| `wave` | | waving with the right hand raised |
| `arms_crossed` | feet (slot: feet) | standing with arms crossed |
| `hands_on_hips` | feet (slot: feet) | standing with fists on the hips |
| `thinking` | | hand to chin, other arm across the body |
| `cover_face` | | both hands covering the face |
| `fight_stance` | | boxing guard, feet staggered |
| `cheer` | | both arms raised overhead |
| `phone` | | looking down at a phone held in the right hand |
| `carry_bag` | | standing, carrying a bag at the side |
| `walk` | phase, arms (slot: arms), feet (slot: feet) | walking stride |
| `run` | phase, arms (slot: arms), feet (slot: feet) | running stride, with moments in the air |
| `sprint` | phase, arms (slot: arms), feet (slot: feet) | fast leaning sprint |
| `jog` | phase, speed (0 walk .. 1 run, default 0.5) | jogging: between a walk and a run |
| `sneak` | phase | sneaking: a walk on the balls of the feet |
| `heel_walk` | phase | walking on the heels, toes up |
| `high_heels_walk` | phase | walking in high heels |
| `walk_phone` | phase | walking while looking at a phone |
| `skate_stride` | phase | ice-skating stride: knees bent, pushing out to the side |
| `gait` | phase, arms (slot: arms), feet (slot: feet), and tuning numbers | a simple sine-wave stride; prefer `walk` |
| `jump` | | airborne jump with knees tucked |
| `crouch` | | low crouch on the balls of the feet |
| `half_crouch` | depth (0 standing .. 1 crouch, default 0.5) | partway from standing to a crouch |
| `squat` | | deep squat, heels down |
| `kneel` | | kneeling on the left knee, right foot planted |
| `kneel_both` | | kneeling on both knees |
| `sit_chair` | | sitting on a chair-height seat |
| `sit_ground` | | sitting cross-legged on the ground |
| `sit_hug_knees` | | sitting on the ground hugging knees |
| `lie_back` | | lying face up |
| `lie_front` | | lying face down |
| `tiptoe` | height (0..1, default 1), arms (slot: arms) | standing on tiptoes |
| `tiptoe_wave` | | waving on tiptoes |
| `plank` | | high plank on the hands and the balls of the feet |
| `ballet` | position (slot: legs, default ballet_first), plie (0..1), releve (0..1), arms (slot: arms) | ballet: a foot position, bent knees, raised heels |
| `exaggerated_cheer` | amount (default 1.3) | a cheer pushed past the pose, for a cartoon reference |

Natural phrasings also work as pose names: `standing`, `idle` -> stand;
`walking` -> walk; `running`, `jogging` -> run; `sprinting` -> sprint;
`jumping` -> jump; `crouching` -> crouch; `squatting` -> squat; `kneeling` ->
kneel; `sitting`, `sit` -> sit_chair; `lying`, `lie` -> lie_back; `pointing`
-> point; `waving` -> wave; `t_pose` -> tpose; `a_pose` -> apose.

### 6.3 Pose parts (for slots)

A slot accepts only a pose that sets its own region. Parts that take `side`
need `left`, `right` or `both`.

| Region | Parts |
| --- | --- |
| arms | `relaxed_arms`, `crossed_arms` (folded across the chest), `fists_on_hips`, `phone_arms` (left relaxed, right holding a phone up), `wave_arms` (left relaxed, right waving), `ballet_arms_low`, `arm_swing(phase, mid, amp, elbow, hands)`, and one-arm parts `relaxed_arm(side)`, `arm_hang(side)`, `point_arm(side)`, `wave_arm(side)`, `phone_arm(side)`, `bag_arm(side)` |
| feet | `flat_feet`, `tiptoe_feet(height)` (high on the balls of the feet), `heel_feet` (on the heels, toes up), `walk_feet(phase)`, `run_feet(phase)`, `sprint_feet(phase)`, `high_heel_feet(phase)`, `skate_feet(edge)` |
| legs | `ballet_first`, `ballet_second`, `ballet_fifth`, and the stride legs `walk_leg(side, phase)`, `run_leg(side, phase)`, `sprint_leg(side, phase)` |
| lower (legs and feet) | `stance(spread, feet)`, `relaxed_stance(feet)` |

Two arm parts can be combined for one arms slot only inside a definition,
since a slot takes one pose (see 6.6).

### 6.4 Atoms

Atoms are the built-in poses. Each sets only the motions it is given.

| Atom | Arguments |
| --- | --- |
| `hips(...)`, `torso(...)`, `head(...)` | motions of that joint, by name: `head(nod_down = 20, turn_left = -10)` |
| `arm(side, ...)`, `elbow(side, ...)`, `wrist(side, ...)`, `leg(side, ...)`, `knee(side, ...)`, `ankle(side, ...)`, `toes(side, ...)` | a side, then motions by name: `arm(left, raise_forward = 90)`. A joint with one motion also takes a plain number: `knee(left, 40)` |
| `hand(side, shape)` | `hand(right, fist)` |
| `foot_roll(side, roll)` | how the foot stands: -1 on the heel (toes up), 0 flat, 1 high on the ball with the toes flat on the floor, 2 on the tips |
| `foot_contact(side, roll)` | the same roll, without setting the ankle angle |
| `reach(effector, part)` | puts a hand or foot on a body part of the same figure: `reach(right_hand, chin)`. `reach(right_hand, none)` releases it |
| `support(part, ...)` | what carries the body: `feet`, `knees`, `hands`, `seat`, `back`, `front`, or one side such as `left_knee`, `right_foot`. Optional `weight = <n>` |
| `lift(height)` | raises the body above its supports, in meters (a jump) |
| `rest(region)` | sets every motion of a region to neutral |

Sides: `left`, `right`, `both`. Motion names and their aliases are those of
section 5.1, without the `left_`/`right_` prefix (`arm(left, swing_back = 20)`).

Regions: `pelvis`, `torso`, `head`, `left_arm`, `right_arm`, `arms`,
`left_hand`, `right_hand`, `hands`, `left_leg`, `right_leg`, `legs`,
`left_foot`, `right_foot`, `feet`, `body`, `upper` (torso, head, arms),
`lower` (pelvis, legs, feet), `all`. An arm region includes its hand. A leg
region is the hip joint and knee. A foot region is the ankle, toes and foot
roll.

What a whole-body pose states with `support` decides how it is grounded:
`seat` with `feet` sits on a seat if one is there; `seat` alone sits on the
floor; `knees`, `hands`, `back` or `front` rest the lowest body point on the
floor; `feet` alone stands.

### 6.5 Blends

- `blend(a, b, t)` interpolates every motion from pose `a` (t = 0) to pose `b`
  (t = 1). `t` above 1 exaggerates; below 0 goes the other way.
- `mix(a, wa, b, wb, ...)` is a weighted average.
- A motion set by only one of the poses keeps that pose's value. To blend
  toward neutral, use `rest(region)` as the other pose:
  `blend(cheer, rest(arms), 0.5)` lowers the arms halfway.
- `mirror(p)` swaps left and right: `mirror(wave)` waves with the left hand.

### 6.6 Defining poses

Define a pose only when the user asks to create, name or reuse a pose, or when
a request needs a combination that no existing pose with slots can express.

```
define pose <name>(<param> = <default>, <slot>: <region> = <default pose>) "<description>"
  <pose or atom>
  <pose or atom>
  ...
end
```

- Each line is an atom, a pose or a blend. **Two lines may not set the same
  motion**; the definition is rejected with an error naming the motion. Mark a
  later line `override` to let it replace motions set above it.
- `$name` uses a parameter. A slot parameter (`arms: arms = relaxed_arms`)
  takes a pose for that region; a line `$arms` inserts it.
- A whole-body pose should state its support (`support(feet)` for standing),
  either directly or through a part such as `flat_feet`.
- The one-line form names a filled pose or a blend:
  `define pose wave_left = mirror(wave)`.
- Defining an existing name replaces it for this scene; `undefine pose
  <name>` restores the library version.
- Names of atoms and functions cannot be used as pose names.

Example:

```
define pose lean_on_wall(arms: arms = crossed_arms) "standing, shoulder against a wall"
  relaxed_stance
  $arms
  torso(lean_left = 8)
  head(tilt_left = 4)
end
pose amy lean_on_wall
```

## 7. Scene text

The current scene is given to you as scene text. It uses the same commands,
grouped into blocks:

```
# simposer scene v1
title "Cafe"
ground plain
style smooth
light azimuth 135 elevation 50 intensity 2.2 fill 0.45

define pose tiptoe_wave "waving on tiptoes"
  stand(arms = wave_arms, feet = tiptoe_feet)
  head(tilt_left = -5)
end

camera
  position 0.2 1.25 2.6
  look_at point 0 0.95 0
  lens 50mm
  aperture f/8
  focus auto
  dof off
  frame free

prop table table at 0 0 facing 0 size 1.2 0.75 0.8

figure mia
  model human
  body adult_female
  at -0.72 0
  facing 90
  pose sit_chair
  set torso bend_forward 18
  reach right_hand to point -0.25 0.78 0.05
  look at leo.face
```

Inside a figure block, lines are `group`, `model`, `body`, `at`, `elevation`,
`facing`, `pose`, `set`, `reach`, `look` and `hand`, without the figure name.
Your reply is a delta: write full commands with the figure name
(`set mia head nod_down 10`), not scene-text lines.

## 8. Rules of thumb

- Prefer a pose, filled through its slots, then refine with `set`, `reach` and
  `look`. Walking and running legs come from the pose; do not `set` leg angles
  on them.
- When a hand touches, covers, holds or points at a body part or object, use
  `reach` (`reach amy right_hand to self.face`), not joint angles.
- People moving in a direction face that direction. "Against the crowd" means
  the crowd faces the opposite way: `facing 180` when the main figure faces 0.
- Crowds go around the main figure (`around <name>`), not around the camera.
- Use `phase` to vary the moment of a stride; crowds already vary it.
- To change what one limb does without losing the rest of the pose, use `set`
  or `reach` rather than a new `pose`, since `pose` clears the figure's edits.
- Leave the camera alone unless asked about framing, angle, lens or focus.

## 9. Examples

Request: an old man standing still while commuters hurry past him in both directions

```dsl
add old_man model human body elderly at 0 0 facing 0 pose stand
add_crowd commuters count 8 around old_man radius 4 pose walk facing random
```

Request: a teenaged girl running against a crowd of passers-by who are walking

```dsl
add runner model human body teen_female at 0 0 facing 0 pose run(phase = 0.3)
add_crowd passersby count 9 around runner radius 5 pose walk facing 180 seed 7
```

Request (follow-up): raise her right hand to cover her face

```dsl
reach runner right_hand to self.face
hand runner right flat
set runner head nod_down 10
```

Request: a woman sitting on a bench reading her phone

```dsl
prop bench bench at 0 0
add reader model human body adult_female at 0 -0.05 facing 0 pose sit_chair
reach reader right_hand to self.chest
set reader head nod_down 35
hand reader right grip
```

Request: a man walking while looking at his phone, on tiptoes

```dsl
add walker model human body adult_male at 0 0 facing 90 pose walk(phase = 0.2, arms = phone_arms, feet = tiptoe_feet)
set walker head nod_down 30
```

Request: make her wave with her left hand instead

```dsl
pose reader mirror(wave)
```

Request: two dancers in second position, one in a deep plie, one rising onto her toes

```dsl
add ana model human body athletic_female at -0.6 0 facing 0 pose ballet(position = ballet_second, plie = 0.8)
add bea model human body athletic_female at 0.6 0 facing 0 pose ballet(position = ballet_second, releve = 1)
```

Request: low angle shot from behind her, 85mm, shallow depth of field

```dsl
camera orbit reader azimuth 160 elevation -10 distance 3
camera lens 85mm
camera aperture f/1.8
camera focus reader.face
```

Request: save this pose as "presenter": standing, right hand pointing ahead, head turned slightly toward the audience

```dsl
define pose presenter "standing and pointing ahead, head turned to the audience"
  relaxed_stance
  relaxed_arm(left)
  point_arm(right)
  head(turn_left = 15)
end
pose amy presenter
```
