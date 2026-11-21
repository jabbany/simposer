// The default pose library: recipes written in the pose language itself.
// Scenes can use these, redefine them, or define new ones (`define pose`).
// Only the atoms in evaluate.ts are built in. See docs/pose-system.md.

import { DslError } from '../../dsl/tokens.ts';
import { readDefineBlock, isDefineLine } from './ast.ts';
import type { PoseDef } from './ast.ts';
import { PoseLibrary, evaluatePose } from './evaluate.ts';
import { inRegion } from './channels.ts';

export const DEFAULT_LIBRARY_TEXT = `
# ---------------------------------------------------------------- feet

define pose flat_feet "both feet flat, carrying the body"
  foot_roll(both, roll = 0)
  support(feet)
end

define pose tiptoe_feet(height = 1) "standing high on the balls of both feet, toes flat"
  foot_roll(both, roll = $height)
  support(feet)
end

define pose heel_feet "standing on both heels, toes up"
  foot_roll(both, roll = -1)
  support(feet)
end

# One foot rolling through a stride (Perry's rockers): contact at the strike
# (on the heel when contact < 0, on the forefoot when > 0), flat in mid
# stance, heel rising onto the ball up to toe-off, then back through the
# swing. The timings are fractions of the cycle after the strike.
define pose gait_foot(side, phase = 0, strike = 0.22, contact = -0.7, stance_roll = 0, flat = 0.08, heel_off = 0.33,
                      toe_off = 0.62, swing = 0.75, peak = 1) "one foot rolling heel to toe through a stride; phase 0..1"
  foot_roll($side, roll = $contact
    + ($stance_roll - $contact) * smoothstep(0, $flat, frac($phase - $strike))
    + ($peak - $stance_roll) * smoothstep($heel_off, $toe_off, frac($phase - $strike))
    - $peak * smoothstep($toe_off, $swing, frac($phase - $strike))
    + $contact * smoothstep($swing, 1, frac($phase - $strike)))
end

define pose rolling_feet(phase = 0, strike = 0.22, contact = -0.7, stance_roll = 0, flat = 0.08, heel_off = 0.33,
                         toe_off = 0.62, swing = 0.75, peak = 1) "both feet rolling through a stride, half a cycle apart; phase 0..1"
  gait_foot(left, phase = $phase, strike = $strike, contact = $contact, stance_roll = $stance_roll, flat = $flat,
            heel_off = $heel_off, toe_off = $toe_off, swing = $swing, peak = $peak)
  gait_foot(right, phase = $phase + 0.5, strike = $strike, contact = $contact, stance_roll = $stance_roll, flat = $flat,
            heel_off = $heel_off, toe_off = $toe_off, swing = $swing, peak = $peak)
  support(feet)
end

# ---------------------------------------------------------------- arms

define pose arm_hang(side) "arm hanging relaxed, slightly out and forward"
  arm($side, raise_sideways = 7, raise_forward = 3)
  elbow($side, bend = 10)
end

define pose relaxed_arm(side) "arm hanging relaxed, fingers loose"
  arm_hang($side)
  hand($side, relaxed)
end

define pose relaxed_arms "both arms hanging relaxed" = relaxed_arm(both)

define pose point_arm(side) "arm pointing straight ahead"
  arm($side, raise_forward = 85, raise_sideways = 8)
  elbow($side, bend = 3)
  hand($side, point)
end

define pose wave_arm(side) "arm raised, hand open and waving"
  arm($side, raise_sideways = 80, raise_forward = 15, twist_out = 90)
  elbow($side, bend = 105)
  wrist($side, bend_thumb_side = 15)
  hand($side, open)
end

define pose phone_arm(side) "forearm up, holding a phone in front of the chest"
  arm($side, raise_forward = 30, raise_sideways = 7, twist_out = -30)
  elbow($side, bend = 108)
  wrist($side, turn_palm_forward = 70)
  hand($side, grip)
end

define pose bag_arm(side) "arm hanging, carrying a bag"
  arm($side, raise_sideways = 14, raise_forward = 3)
  elbow($side, bend = 4)
  hand($side, grip)
end

define pose crossed_arms "arms folded across the chest"
  arm(left, raise_forward = 22, raise_sideways = 8, twist_out = -78)
  elbow(left, bend = 118)
  arm(right, raise_forward = 30, raise_sideways = 8, twist_out = -80)
  elbow(right, bend = 112)
end

define pose fists_on_hips "fists resting on the hips, elbows out"
  arm_hang(both)
  reach(left_hand, left_hip)
  reach(right_hand, right_hip)
  hand(both, fist)
end

define pose arm_swing(phase = 0, mid = 2, amp = 18, elbow = 15, hands = relaxed) "arms swinging against the legs; phase 0 = left heel strike (left arm back)"
  arm(left, raise_forward = $mid - $amp * cos(tau * $phase), raise_sideways = 8)
  arm(right, raise_forward = $mid + $amp * cos(tau * $phase), raise_sideways = 8)
  elbow(both, bend = $elbow)
  hand(both, $hands)
end

# ---------------------------------------------------------------- legs

define pose stance(spread = 2, feet: feet = flat_feet) "both legs straight, slightly apart"
  leg(both, raise_sideways = $spread)
  $feet
end

define pose relaxed_stance(feet: feet = flat_feet) "standing with the weight a little on one leg"
  hips(lean_left = 1.5)
  leg(left, raise_sideways = 3)
  leg(right, raise_sideways = 1)
  $feet
end

# spread: legs apart; push_out: the leg pushes out to the side behind the body (skating)
define pose leg_stride(side, phase = 0, mid = 6, amp = 20, stance = 10, swing = 52, spread = 0, push_out = 0) "one leg (hip and knee) through a stride; phase 0..1"
  leg($side, raise_forward = $mid + $amp * sin(tau * $phase), raise_sideways = $spread + $push_out * max(0, -sin(tau * $phase)))
  knee($side, bend = $stance + $swing * pow(max(0, cos(tau * $phase - 0.35)), 1.4))
end

define pose gait(phase = 0, mid = 6, amp = 20, stance = 10, swing = 52, spread = 0, push_out = 0, lean = 3, turn = 5,
                 arms: arms = arm_swing(phase = $phase - 0.25), feet: feet = rolling_feet(phase = $phase)) "a simple sine-wave stride with pelvis and spine counter-turning; phase 0..1"
  leg_stride(left, phase = $phase, mid = $mid, amp = $amp, stance = $stance, swing = $swing, spread = $spread, push_out = $push_out)
  leg_stride(right, phase = $phase + 0.5, mid = $mid, amp = $amp, stance = $stance, swing = $swing, spread = $spread, push_out = $push_out)
  hips(turn_left = -$turn * sin(tau * $phase))
  torso(twist_left = 1.4 * $turn * sin(tau * $phase), bend_forward = $lean)
  $arms
  $feet
end

# ---------------------------------------------------------------- standing

define pose stand(arms: arms = relaxed_arms, feet: feet = flat_feet) "relaxed standing, arms at sides"
  relaxed_stance(feet = $feet)
  $arms
end

define pose attention(feet: feet = flat_feet) "straight upright standing"
  arm(both, raise_sideways = 4)
  $feet
end

define pose tpose(feet: feet = flat_feet) "arms straight out to the sides"
  arm(both, raise_sideways = 90)
  hand(both, flat)
  $feet
end

define pose apose(feet: feet = flat_feet) "arms angled down 45 degrees"
  arm(both, raise_sideways = 45)
  hand(both, flat)
  $feet
end

define pose point "pointing ahead with the right arm"
  stance(spread = 2)
  relaxed_arm(left)
  point_arm(right)
  head(turn_left = -4)
end

define pose wave "waving with the right hand raised"
  stance(spread = 2)
  relaxed_arm(left)
  wave_arm(right)
  head(tilt_left = -5)
end

define pose arms_crossed(feet: feet = flat_feet) "standing with arms crossed"
  stance(spread = 4, feet = $feet)
  crossed_arms
end

define pose hands_on_hips(feet: feet = flat_feet) "standing with fists on the hips"
  stance(spread = 5, feet = $feet)
  fists_on_hips
end

define pose thinking "hand to chin, other arm across the body"
  stance(spread = 3)
  arm(left, raise_forward = 12, raise_sideways = 5, twist_out = -70)
  elbow(left, bend = 100)
  reach(right_hand, chin)
  hand(right, relaxed)
  head(nod_down = 8, tilt_left = -6)
end

define pose cover_face "both hands covering the face"
  head(nod_down = 18)
  torso(bend_forward = 12)
  reach(left_hand, left_cheek)
  reach(right_hand, right_cheek)
  hand(both, flat)
  support(feet)
end

define pose fight_stance "boxing guard, feet staggered"
  leg(left, raise_forward = 22, raise_sideways = 8)
  leg(right, raise_forward = -12, raise_sideways = 8)
  knee(left, bend = 22)
  knee(right, bend = 18)
  hips(turn_left = -25)
  torso(twist_left = 12)
  head(turn_left = 12, nod_down = 10)
  arm(left, raise_forward = 55, raise_sideways = 10, twist_out = -35)
  elbow(left, bend = 105)
  arm(right, raise_forward = 42, raise_sideways = 15, twist_out = -45)
  elbow(right, bend = 130)
  hand(both, fist)
  support(feet)
end

define pose cheer "both arms raised overhead"
  arm(both, raise_forward = 160, raise_sideways = 25)
  elbow(both, bend = 12)
  hand(both, open)
  head(nod_down = -15)
  support(feet)
end

define pose phone "looking down at a phone held in the right hand"
  stance(spread = 2)
  relaxed_arm(left)
  phone_arm(right)
  head(nod_down = 35)
  torso(bend_forward = 4)
end

define pose carry_bag "standing, carrying a bag at the side"
  stance(spread = 2)
  relaxed_arm(left)
  bag_arm(right)
  torso(lean_left = 5)
end

# ---------------------------------------------------------------- moving

# Walking, running and sprinting from joint-angle data: each table is one
# stride sampled every 5% from the leg's own foot strike (phase 0) to the
# next, read by cycle() as a smooth periodic curve. Degrees of hip flexion,
# knee flexion and ankle dorsiflexion (ankle point is its negative), after
# normal gait data (Perry; Winter) and running kinematics. foot_contact is
# the foot's roll on the floor: heel strike, flat, heel rising onto the ball
# with the toes bent flat, toe-off.

# The pelvis turns with the stride and the chest against it; the hips turn
# the legs back so that planted feet keep their heading on the floor. Gait
# data measures hip angles against a pelvis tilted forward (tilt), so the
# pelvis is tilted and the spine straightens by as much (lean is the trunk's
# lean in space).
define pose stride_turn(phase = 0, turn = 4, tilt = 10, lean = 3) "pelvis and chest counter-turning through a stride; phase 0 = left foot strike"
  hips(turn_left = -$turn * cos(tau * $phase), bend_forward = $tilt)
  leg(left, twist_out = $turn * cos(tau * $phase))
  leg(right, twist_out = -$turn * cos(tau * $phase))
  torso(twist_left = 1.75 * $turn * cos(tau * $phase), bend_forward = $lean - $tilt)
end

# inward: the legs angle in so the feet land close to the midline (a step
# width of about 10 cm), not straight under the hip joints
define pose walk_leg(side, phase = 0, inward = 4) "one leg (hip and knee) through a walking stride; phase 0 = its heel strike"
  leg($side, raise_forward = cycle($phase, 30, 29, 26, 22, 18, 14, 10, 6, 2, -2, -6, -9, -8, -2, 7, 16, 24, 30, 32, 31), raise_sideways = -$inward)
  knee($side, bend = cycle($phase, 5, 12, 17, 18, 16, 12, 9, 6, 5, 6, 10, 20, 35, 50, 60, 60, 50, 33, 15, 6))
end

define pose walk_foot(side, phase = 0) "one foot through a walking stride: ankle angle, and the roll from heel strike to toe-off"
  ankle($side, point = -cycle($phase, 0, -5, -3, 1, 4, 6, 8, 9, 10, 10, 6, -4, -15, -18, -10, -4, 0, 1, 1, 0))
  foot_contact($side, roll = cycle($phase, -0.8, -0.25, 0, 0, 0, 0, 0, 0, 0.03, 0.1, 0.22, 0.5, 1, 0.9, 0.5, 0.15, 0, -0.2, -0.5, -0.75))
end

define pose walk_feet(phase = 0) "both feet through a walking stride, half a cycle apart; phase 0 = left heel strike"
  walk_foot(left, phase = $phase)
  walk_foot(right, phase = $phase + 0.5)
  support(feet)
end

define pose walk(phase = 0, arms: arms = arm_swing(phase = $phase), feet: feet = walk_feet(phase = $phase))
  "walking stride; phase 0..1 picks the moment in the cycle (0 = left heel strike)"
  walk_leg(left, phase = $phase)
  walk_leg(right, phase = $phase + 0.5)
  stride_turn(phase = $phase, turn = 4, lean = 3)
  $arms
  $feet
end

define pose run_leg(side, phase = 0, inward = 5) "one leg (hip and knee) through a running stride; phase 0 = its foot strike"
  leg($side, raise_forward = cycle($phase, 40, 36, 30, 22, 14, 6, 0, -6, -10, -8, 0, 12, 24, 34, 42, 47, 48, 47, 44, 42), raise_sideways = -$inward)
  knee($side, bend = cycle($phase, 20, 32, 40, 38, 32, 25, 20, 18, 20, 35, 55, 75, 90, 95, 92, 80, 60, 40, 25, 18))
end

define pose run_foot(side, phase = 0) "one foot through a running stride: light heel strike, push off by 40%"
  ankle($side, point = -cycle($phase, 5, 15, 22, 25, 22, 15, 5, -8, -18, -20, -12, -5, 0, 5, 8, 10, 10, 8, 6, 5))
  foot_contact($side, roll = cycle($phase, -0.3, 0, 0, 0.05, 0.2, 0.4, 0.65, 0.9, 1, 0.8, 0.4, 0.1, 0, 0, 0, 0, -0.05, -0.15, -0.25, -0.3))
end

define pose run_feet(phase = 0) "both feet through a running stride, half a cycle apart"
  run_foot(left, phase = $phase)
  run_foot(right, phase = $phase + 0.5)
  support(feet)
end

define pose sprint_leg(side, phase = 0, inward = 5) "one leg (hip and knee) through a sprinting stride; phase 0 = its foot strike"
  leg($side, raise_forward = cycle($phase, 45, 40, 32, 22, 12, 2, -6, -12, -10, 0, 14, 30, 44, 56, 63, 66, 65, 60, 54, 49), raise_sideways = -$inward)
  knee($side, bend = cycle($phase, 25, 35, 42, 38, 30, 22, 18, 20, 35, 60, 90, 115, 125, 122, 110, 90, 65, 45, 32, 26))
end

define pose sprint_foot(side, phase = 0) "one foot through a sprint: landing on the forefoot, heel barely down"
  ankle($side, point = -cycle($phase, -5, 8, 18, 22, 18, 8, -8, -20, -25, -18, -8, 0, 5, 8, 8, 6, 4, 2, 0, -3))
  foot_contact($side, roll = cycle($phase, 0.5, 0.3, 0.25, 0.3, 0.5, 0.75, 0.95, 1.05, 0.9, 0.5, 0.2, 0.1, 0.1, 0.1, 0.1, 0.15, 0.2, 0.3, 0.4, 0.45))
end

define pose sprint_feet(phase = 0) "both feet through a sprint, half a cycle apart"
  sprint_foot(left, phase = $phase)
  sprint_foot(right, phase = $phase + 0.5)
  support(feet)
end

# Running has moments with both feet off the ground, after each toe-off.
define pose flight(phase = 0, height = 0.04) "airborne moments of a run; phase 0 = left foot strike"
  lift(max(0, $height * cycle($phase, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 1, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 1)))
end

define pose run(phase = 0, arms: arms = arm_swing(phase = $phase, mid = -10, amp = 32, elbow = 90, hands = grip), feet: feet = run_feet(phase = $phase))
  "running stride; phase 0..1 (0 = left foot strike)"
  run_leg(left, phase = $phase)
  run_leg(right, phase = $phase + 0.5)
  stride_turn(phase = $phase, turn = 6, lean = 10)
  flight(phase = $phase, height = 0.04)
  $arms
  $feet
end

define pose sprint(phase = 0, arms: arms = arm_swing(phase = $phase, mid = -5, amp = 50, elbow = 95, hands = grip), feet: feet = sprint_feet(phase = $phase))
  "fast leaning sprint; phase 0..1 (0 = left foot strike)"
  sprint_leg(left, phase = $phase)
  sprint_leg(right, phase = $phase + 0.5)
  stride_turn(phase = $phase, turn = 7, lean = 22)
  flight(phase = $phase, height = 0.07)
  $arms
  $feet
end

define pose jump "airborne jump with knees tucked"
  leg(both, raise_forward = 55)
  knee(both, bend = 85)
  ankle(both, point = 30)
  arm(both, raise_forward = 70, raise_sideways = 30)
  elbow(both, bend = 25)
  torso(bend_forward = 8)
  head(nod_down = -5)
  support(feet)
  lift(0.45)
end

# ---------------------------------------------------------------- low

define pose crouch "low crouch on the balls of the feet"
  hips(bend_forward = 30)
  leg(both, raise_forward = 105, raise_sideways = 22, twist_out = 18)
  knee(both, bend = 125)
  ankle(both, point = -40)
  torso(bend_forward = 10)
  head(nod_down = -20)
  arm(both, raise_forward = 35, raise_sideways = 10)
  elbow(both, bend = 35)
  support(feet)
end

define pose squat "deep squat, heels down"
  hips(bend_forward = 20)
  leg(both, raise_forward = 115, raise_sideways = 24, twist_out = 12)
  knee(both, bend = 138)
  ankle(both, point = -38, turn_out = 20)
  torso(bend_forward = 15)
  head(nod_down = -15)
  arm(both, raise_forward = 70)
  elbow(both, bend = 20)
  support(feet)
end

define pose kneel "kneeling on the left knee, right foot planted"
  leg(left, raise_forward = 0)
  knee(left, bend = 90)
  ankle(left, point = 40)
  leg(right, raise_forward = 90)
  knee(right, bend = 90)
  leg(both, raise_sideways = 2)
  arm_hang(both)
  reach(right_hand, right_knee)
  support(left_knee, left_foot, right_foot)
end

define pose kneel_both "kneeling on both knees"
  leg(both, raise_forward = 0, raise_sideways = 4)
  knee(both, bend = 95)
  ankle(both, point = 40)
  reach(left_hand, left_thigh)
  reach(right_hand, right_thigh)
  support(knees, feet)
end

# ---------------------------------------------------------------- sitting and lying

define pose sit_chair "sitting on a chair-height seat"
  leg(both, raise_forward = 90, raise_sideways = 6)
  knee(both, bend = 90)
  torso(bend_forward = -4)
  reach(left_hand, left_thigh)
  reach(right_hand, right_thigh)
  support(seat, feet)
end

define pose sit_ground "sitting cross-legged on the ground"
  hips(bend_forward = -8)
  leg(both, raise_forward = 88, raise_sideways = 58, twist_out = 55)
  knee(both, bend = 148)
  ankle(both, point = 25)
  torso(bend_forward = 14)
  head(nod_down = 5)
  reach(left_hand, left_knee)
  reach(right_hand, right_knee)
  support(seat)
end

define pose sit_hug_knees "sitting on the ground hugging knees"
  hips(bend_forward = -25)
  leg(both, raise_forward = 115)
  knee(both, bend = 140)
  ankle(both, point = 10)
  torso(bend_forward = 35)
  head(nod_down = 10)
  reach(left_hand, right_shin)
  reach(right_hand, left_shin)
  support(seat)
end

define pose lie_back "lying face up"
  hips(bend_forward = -90)
  arm(both, raise_sideways = 12)
  elbow(both, bend = 10)
  ankle(both, point = 25)
  leg(both, twist_out = 15)
  support(back)
end

define pose lie_front "lying face down"
  hips(bend_forward = 90)
  arm(both, raise_sideways = 20)
  elbow(both, bend = 10)
  ankle(both, point = 60)
  head(turn_left = 70, nod_down = -10)
  support(front)
end

# ---------------------------------------------------------------- recomposed
# New poses made only by filling slots of the poses above, or by blending.

define pose tiptoe(height = 1, arms: arms = relaxed_arms) "standing on tiptoes"
  = stand(arms = $arms, feet = tiptoe_feet(height = $height))

define pose sneak(phase = 0) "sneaking: a walk on the balls of the feet; phase 0..1"
  = walk(phase = $phase, feet = tiptoe_feet(height = 0.7))

define pose heel_walk(phase = 0) "walking on the heels, toes up; phase 0..1"
  = walk(phase = $phase, feet = heel_feet)

define pose high_heel_feet(phase = 0) "feet in high heels: the heel never touches; rolls onto the toes to push off"
  = rolling_feet(phase = $phase, strike = 0, contact = 0.45, stance_roll = 0.55, peak = 1)

define pose high_heels_walk(phase = 0) "walking in high heels; phase 0..1"
  = walk(phase = $phase, feet = high_heel_feet(phase = $phase))

define pose skate_feet(edge = 8) "skates: blades flat on the ice, tilted onto the inner edge, no heel-to-toe roll"
  foot_roll(both, roll = 0)
  ankle(both, roll_in = -$edge, turn_out = 15)
  support(feet)
end

define pose skate_stride(phase = 0) "ice-skating stride: knees bent, pushing out to the side and gliding; phase 0..1"
  = gait(phase = $phase, mid = 12, amp = 16, stance = 30, swing = 30, spread = 4, push_out = 22, lean = 20, turn = 6,
         arms = arm_swing(phase = $phase - 0.25, mid = 6, amp = 30, elbow = 25), feet = skate_feet)

define pose phone_arms "left arm relaxed, right hand holding a phone up"
  relaxed_arm(left)
  phone_arm(right)
end

define pose wave_arms "left arm relaxed, right arm waving"
  relaxed_arm(left)
  wave_arm(right)
end

define pose walk_phone(phase = 0) "walking while looking at a phone; phase 0..1"
  walk(phase = $phase, arms = phone_arms)
  head(nod_down = 30)
end

define pose tiptoe_wave "waving on tiptoes"
  stand(arms = wave_arms, feet = tiptoe_feet)
  head(tilt_left = -5)
end

define pose plank "high plank: straight body on the hands and the balls of the feet"
  hips(bend_forward = 76)
  arm(both, raise_forward = 76, raise_sideways = 6)
  wrist(both, bend = -76)
  hand(both, flat)
  leg(both, raise_sideways = 3)
  head(nod_down = -20)
  foot_roll(both, roll = 1.3)
  support(hands, feet)
end

define pose ballet_first "first position: heels together, toes turned out"
  leg(both, raise_sideways = 1, twist_out = 40)
end

define pose ballet_second "second position: feet apart, toes turned out"
  leg(both, raise_sideways = 14, twist_out = 40)
end

define pose ballet_fifth "fifth position: right foot in front of the left, both turned out"
  leg(left, raise_sideways = 2, raise_forward = -3, twist_out = 40)
  leg(right, raise_sideways = -2, raise_forward = 4, twist_out = 40)
end

define pose ballet_arms_low "arms rounded low in front of the body (bras bas)"
  arm(both, raise_forward = 18, raise_sideways = 10, twist_out = -30)
  elbow(both, bend = 30)
  hand(both, open)
end

define pose ballet(position: legs = ballet_first, plie = 0, releve = 0, arms: arms = ballet_arms_low)
  "ballet: a foot position, bent knees (plie 0..1), heels raised (releve 0..1)"
  $position
  knee(both, bend = 70 * $plie)
  foot_roll(both, roll = $releve)
  support(feet)
  $arms
  torso(bend_forward = -3)
  head(nod_down = -5)
end

define pose jog(phase = 0, speed = 0.5) "jogging: between a walk (speed 0) and a run (speed 1); phase 0..1"
  = blend(walk(phase = $phase), run(phase = $phase), $speed)

define pose half_crouch(depth = 0.5) "partway from standing to a crouch (depth 0..1)"
  = blend(stand, crouch, $depth)

define pose exaggerated_cheer(amount = 1.3) "a cheer pushed past the pose, for a cartoon reference"
  = blend(stand, cheer, $amount)
`;

/** Words accepted for pose names (natural phrasing -> pose). */
export const POSE_ALIASES: Record<string, string> = {
  standing: 'stand', idle: 'stand', walking: 'walk', running: 'run', jog: 'run', jogging: 'run', sprinting: 'sprint',
  jumping: 'jump', crouching: 'crouch', squatting: 'squat', kneeling: 'kneel', sitting: 'sit_chair', sit: 'sit_chair',
  lying: 'lie_back', lie: 'lie_back', pointing: 'point', waving: 'wave', t_pose: 'tpose', a_pose: 'apose',
};

/** Parse a text made only of `define pose` blocks (and comments). */
export function parsePoseLibrary(text: string): PoseDef[] {
  const lines = text.split(/\r?\n/);
  const defs: PoseDef[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = (lines[i] ?? '').replace(/#.*$/, '').trim();
    if (t.length === 0) {
      i++;
      continue;
    }
    if (!isDefineLine(t)) {
      throw new DslError(`expected "define pose" but got "${t}"`, i + 1);
    }
    const r = readDefineBlock(lines, i);
    defs.push(r.def);
    i = r.next;
  }
  return defs;
}

let defaults: PoseDef[] | null = null;

/** The built-in recipes, parsed once. */
export function defaultPoseDefs(): PoseDef[] {
  if (defaults === null) {
    defaults = parsePoseLibrary(DEFAULT_LIBRARY_TEXT);
  }
  return defaults;
}

/** The library for a scene: default recipes, then the scene's own definitions. */
export function libraryFor(user: PoseDef[]): PoseLibrary {
  return new PoseLibrary(defaultPoseDefs(), user, POSE_ALIASES);
}

/**
 * Short signature for docs and prompts: `walk(phase, arms, feet)`. Poses with
 * many tuning parameters show only the phase and their slots.
 */
export function poseSignature(def: PoseDef): string {
  const shown = def.params.length <= 3 ? def.params : def.params.filter((p) => p.region !== null || p.name === 'phase' || p.name === 'side');
  return shown.length === 0 ? def.name : `${def.name}(${shown.map((p) => p.name).join(', ')}${shown.length < def.params.length ? ', ...' : ''})`;
}

const PART_REGIONS = ['feet', 'legs', 'lower', 'hands', 'arms', 'head', 'torso', 'upper'];

/**
 * Building blocks for slots, grouped by the smallest region that holds them
 * (feet, legs, arms, ...). Poses needing arguments without defaults (one-arm
 * parts like `wave_arm(side)`) are listed under the region of their sides.
 */
export function partsByRegion(lib: PoseLibrary): Map<string, PoseDef[]> {
  const out = new Map<string, PoseDef[]>();
  for (const d of lib.all()) {
    if (isWholeBodyPose(lib, d) || d.description.length === 0) {
      continue;
    }
    let v;
    try {
      const args = d.params.filter((p) => p.def === null).map((p) => ({ name: p.name, value: { k: 'word' as const, w: p.name === 'side' ? 'both' : p.name } }));
      v = evaluatePose(lib, { k: 'call', name: d.name, args });
    } catch {
      continue;
    }
    const keys = [...v.ch.keys(), ...[...v.goals.keys()].map((e) => `goal.${e}`)];
    const region = PART_REGIONS.find((r) => keys.length > 0 && keys.every((k) => inRegion(k, r))) ?? 'all';
    const list = out.get(region) ?? [];
    list.push(d);
    out.set(region, list);
  }
  return out;
}

/** Whole-body poses of a library, in definition order. */
export function wholeBodyPoses(lib: PoseLibrary): PoseDef[] {
  return lib.all().filter((d) => isWholeBodyPose(lib, d));
}

const fullCache = new WeakMap<PoseDef, boolean>();

/**
 * Whole-body poses (those that say what carries the body) are offered as
 * figure poses in the UI; parts such as `relaxed_arms` are building blocks.
 */
export function isWholeBodyPose(lib: PoseLibrary, def: PoseDef): boolean {
  const cached = fullCache.get(def);
  if (cached !== undefined) {
    return cached;
  }
  let full = false;
  if (def.params.every((p) => p.def !== null)) {
    try {
      const v = evaluatePose(lib, { k: 'call', name: def.name, args: [] });
      // says what carries the body, and covers the arms too (not just a
      // feet or legs building block)
      full = [...v.ch.keys()].some((k) => k.startsWith('support.'))
        && ([...v.ch.keys()].some((k) => inRegion(k, 'arms')) || [...v.goals.keys()].some((e) => inRegion(`goal.${e}`, 'arms')));
    } catch {
      full = false;
    }
  }
  fullCache.set(def, full);
  return full;
}
