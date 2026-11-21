// Canned delta scripts so the pipeline can be explored without an LLM.

export interface Example {
  label: string;
  request: string;
  delta: string;
  /** apply to an empty scene instead of the current one */
  fresh: boolean;
}

export const EXAMPLES: Example[] = [
  {
    label: 'Running against the crowd',
    request: 'A teenaged female running against a crowd of passers by who are walking',
    fresh: true,
    delta: `title "Against the current"
ground street
add runner model human body teen_female at 0 0 facing 0 pose run phase 0.3
set runner torso bend_forward 14
add_crowd passersby count 9 around runner radius 5 pose walk facing 180 seed 7
camera orbit runner azimuth 20 elevation 8 distance 11
camera lens 40mm`,
  },
  {
    label: 'Refine: hand covers face',
    request: 'raise her right hand to cover her face',
    fresh: false,
    delta: `reach runner right_hand to self.face
hand runner right flat
set runner head nod_down 10`,
  },
  {
    label: 'Two people talking',
    request: 'two friends chatting at a cafe table, one leaning in',
    fresh: true,
    delta: `title "Cafe"
ground plain
prop table table at 0 0
prop chair_a chair at -0.75 0 facing 90
prop chair_b chair at 0.75 0 facing -90
add mia model human body adult_female at -0.72 0 facing 90 pose sit_chair
add leo model human body adult_male at 0.72 0 facing -90 pose sit_chair
set mia torso bend_forward 18
reach mia right_hand to point -0.25 0.78 0.05
look mia at leo.face
look leo at mia.face
reach leo left_hand to leo.chin
camera position 0.2 1.25 2.6
camera look_at point 0 0.95 0
camera lens 50mm`,
  },
  {
    label: 'Body types lineup',
    request: 'line up different body types for comparison',
    fresh: true,
    delta: `title "Lineup"
ground grid
add a model human body adult_male at -3 0 facing 0
add b model human body adult_female at -2 0 facing 0
add c model human body heavy_male at -1 0 facing 0
add d model human body teen_female at 0 0 facing 0
add e model human body child at 1 0 facing 0
add f model human body anime_female at 2 0 facing 0
add g model human body chibi at 3 0 facing 0
add h model human body elderly at -1.5 -1.6 facing 0
add i model human body athletic_male at 0 -1.6 facing 0
add j model human body heavy_female at 1.5 -1.6 facing 0
camera position 0 1.3 7.5
camera angles 180 -4
camera lens 35mm`,
  },
];
