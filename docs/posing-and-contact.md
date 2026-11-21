# Posing and contact

This document follows a pose from joint angles to a skinned figure standing on
the floor: how one pose definition drives any humanoid rig, how deep bends
keep their shape, how limbs stay out of the body, and how the figure meets
the ground and props.

## Retargeting to any rig

- **Bone names.** `src/rig/boneMap.ts` maps a model's bone names onto a
  canonical humanoid skeleton. It recognizes Mixamo, Unreal and Quaternius,
  VRM, Rigify and plain names. A `boneMap` entry in
  `public/models/manifest.json` can override any mapping.
- **Rest pose.** `src/rig/rig.ts` measures each rig in its rest pose and
  normalizes it: facing +Z, feet on the ground, scaled to the figure's
  height. For every bone it computes a rotation `C` from the rest pose
  (T-pose, A-pose or anything else) to an anatomical zero pose: standing,
  arms down, palms facing the thighs.
- **Solver.** `src/pose/solve.ts` builds each bone's rotation `R` in the zero
  pose's frame from the pose's joint angles, then adjusts it for reaches,
  contact and collisions. The bone's final rotation is `R * C * rest`, where
  `rest` is the bone's rotation in the model's rest pose. Because `C` absorbs
  the differences between rigs, the same angles give the same pose on every
  model.
- **Landmarks.** `src/pose/landmarks.ts` defines named points on the body
  (face, cheeks, shoulders, hips, knees, heels, toes and so on), placed
  relative to bones. They label body parts in the interface, serve as reach
  and look targets, and give the solver points to ground the body with.

The solver works in this order:

1. joint angles from the pose;
2. foot reaches;
3. grounding on the support surface;
4. leg self-collision, then the feet placed on the floor;
5. hand reaches, with the palm turned onto the target surface;
6. arm self-collision;
7. the head turned toward a look target.

## Skinning and deep bends

- **Dual quaternion skinning.** Figures are skinned with dual quaternions
  (`src/render/dqs.ts`, a patch of three.js's skinning shader chunks that the
  shadow pass uses too). Linear blend skinning loses volume at joints that
  bend or twist far, as in the "candy wrapper" of a twisted wrist.
- **Half-joint helper bones.** The human figure has helper bones at the hips,
  knees, ankles, shoulders, elbows, wrists and neck. Each follows half of its
  joint's rotation and takes part of the skin weights around the joint, so a
  deeply bent knee or elbow keeps its shape.
- **Forearm twist.** The wrist's `turn_palm_forward` motion (the forearm's
  twist) is applied by rotating the hand bone. The skin of the lower forearm
  follows through the wrist's helper bone, and the elbow crease does not turn
  with the palm.
- **Joint limits.** The solver limits the elbow to 148 degrees of flexion and
  the knee to 152. Wrist swing and forearm twist are limited too.

## Reaches

`reach` places a hand or foot with two-bone IK (inverse kinematics: solving
the joint angles that put the end of a limb at a given point). For a hand on a surface
(a cheek, a thigh, a point on the floor), the palm is placed on the surface
and turned to face into it. The elbow's direction depends on the target: down
and back for low targets beside the body, such as hands on the hips, and down
and forward for targets in front of the face, such as a hand under the chin.

Two-bone IK fixes where the hand or foot goes but not which way the elbow or
knee points, so the solver needs a direction for it. When it moves a leg, the
knee points where the thigh bone's forward axis points. A direction taken
from the bend of the leg would be lost as the leg straightens, and the knee
would flip.

A reach goal can have a weight below 1 when two poses are blended. The hand
or foot then moves only that fraction of the way from where the joint angles
put it toward the target.

## Self-collision

Capsules are fitted to the deformed mesh for each limb segment. The capsules
for the spine and chest use the body's front-to-back depth rather than its
width, and the chest capsule stops short of the neck, which is much thinner.
Spheres model the belly and chest. The solver resolves:

- legs against the trunk and each other: a crouching thigh against the belly,
  crossed shins, colliding feet;
- arms against the trunk, head, thighs and each other.

A free limb is pushed away by turning it at the hip or shoulder. A limb whose
end is pinned, such as a reaching hand or a planted foot, swivels about the
line from its root to its end instead, so the hand or foot stays where it is.
A hand that reaches for part of the body may touch that region, so a fist
under the chin is not pushed away from the chin.

## Supports under the figure

`supportUnder` in `src/render/viewport.ts` decides what the figure stands or
sits on:

- A standing figure stands on the floor, or on the top of a box, step or
  table when its position is over one.
- A sitting pose sits on a chair, bench, box or step whose footprint,
  enlarged by 12 cm on each side, contains the figure's position. If there
  are several, it takes the one the figure is most centred on, and a table
  only when there is nothing else. A chair prop is 90 cm tall including its
  back, so its seat height is taken as 46 cm (or the prop's height, if lower).

## Standing, walking and running

Standing feet are placed the way game engines place feet on uneven ground:
each foot has a plant weight, the planted foot is blended with the animated
one by that weight, and the pelvis is lowered as far as the feet need (see,
for example, Unreal's Foot Placement node and the Vulkan tutorial on foot
placement in the references). Every step below is a continuous function of
the pose, so a stride moves smoothly as its phase changes.

In this section, the animated foot or leg means where the pose's joint angles
put it, before the solver adjusts it for contact.

1. **Plant weight.** Each foot gets a weight from its height above the floor:
   1 on the floor, falling smoothly to 0 at 5 cm.
2. **Planted foot.** The foot is turned the way it meets the floor: the sole
   at the angle of its declared roll (see
   [pose-system.md](pose-system.md)), or, without a roll, flat or on the ball
   depending on how high the heel is. The target is a direction, the foot's
   heading on the floor tilted by the roll's angle, which gives one answer
   whatever the animated foot's orientation.
3. **Toes.** Once the foot is on its ball, the toes are turned to keep the
   angle they have when standing flat, so they lie on the floor and the foot
   bends at the ball.
4. **Ball pivot.** A foot on its ball that the leg holds above the floor lets
   its heel rise further until the ball reaches the floor, up to a foot pitch
   of 55 degrees. A foot already steeper than that, such as one at roll 2,
   keeps its own angle.
   Toe-off happens when the leg lifts the foot beyond that. The limit is 55
   degrees because a steeper foot barely lowers its ball as the heel rises,
   and the foot would swing abruptly.
5. **Orientation weight.** A foot turns toward its planted orientation over
   the last 15 cm above the floor, and is placed on the floor over the last
   5 cm. A swinging foot prepares for contact and lands smoothly.
6. **Grounding.** The body is placed by the lowest point of the feet as they
   will be planted, not as the animation holds them. In a run the animation
   can point a foot's toes into the floor; grounding on that toe would sink
   the whole body.
7. **Pelvis offset.** The pelvis is lowered by the largest amount any planted
   leg needs to reach its foot at its animated length (hip to ankle), each weighted by its
   plant weight. This produces double support without a separate rule, and
   the body rises back smoothly as a foot lifts.
8. **Legs.** Each leg is solved by two-bone IK. Its ankle target goes from
   where the animated leg puts it, carried with the pelvis, to the planted
   position, by the plant weight.
9. **Nothing below the floor.** A foot that ends up below the floor is
   lifted out.

Step 7 never asks a leg to be longer than the animation made it. This avoids
a known problem of two-bone IK: near full extension the knee moves with the
square root of the remaining length, so a small change in the target makes
the knee jump.

A lifted body, in a run's flight phase or a jump, unplants its feet through
the same weights: as the feet rise above the floor their weights fall to 0,
so lift-off and landing are continuous.

## Resting limbs

- Kneeling, floor-sitting and lying feet turn at the ankle until the instep,
  toes or heel touch the floor. They then reach the floor by bending only the
  knee, so the seat or knee that carries the body does not move.
- A hand reaching for a point on the floor lies flat, palm down.

## Exact contact

Landmarks are estimates, so after posing, `src/rig/posing.ts` measures the
deformed skin and corrects the solve. It measures the soles, the seat (the
buttocks and the upper back of the thighs) or the lowest body point,
depending on the pose. The gap is fed back into the solver as an offset for
up to four more passes. A standing or walking foot is corrected by its
sole-to-skin offset: the height between the sole points the solver places
(heel, ball and toe tip) and the lowest point of that foot's deformed skin.
The offset varies smoothly with the foot's angle. A resting foot is corrected
by its measured gap to the floor, with damping.

Measured on the body presets with local scripts that are not part of the
repository:

- Standing, crouching, squatting, kneeling, sitting on a chair or on the
  floor, and lying are within a few millimetres of the floor or seat, mostly
  under 2 mm. Some kneeling feet sit up to about 6 mm into the floor.
- Through a whole walk or run cycle, the soles in contact stay within 0.5 mm
  of the floor, and no foot hovers while it carries weight.
- A figure with short legs on a chair-height seat, such as the chibi preset,
  leaves its feet dangling, as it should.

## References

- Unreal Engine: [AnimNode FootPlacement](https://api.unrealengine.com/INT/PythonAPI/class/AnimNode_FootPlacement.html)
- Vulkan tutorial: [Foot placement on uneven terrain](https://docs.vulkan.org/tutorial/latest/Advanced_glTF/Procedural_Animation_IK/04_foot_placement.html)
- Gait rockers: [Rockers and rollovers (LER)](https://lermagazine.com/?p=17081)
