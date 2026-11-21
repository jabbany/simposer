# Interface

The picture is what the user came for, so the interface stays out of it. The
HUD (heads-up display: the interface drawn over the picture, in
`src/ui/hud.ts`) borrows from third-person games: the mouse looks
around, the keyboard walks the camera, and panels appear only when the user
stops to interact.

## Look mode

A click on empty scene, or the Look button, enters look mode. The mouse is
captured and no interface is shown. Name tags, the framing
guides and the selection tint are hidden, so figures show their true shading. A small aim dot
and the name of the figure under it appear while the mouse moves, then fade.

- The mouse looks around. `W`, `A`, `S`, `D` walk; `Q` and `E` go down and up;
  `Shift` is faster.
- The arrow keys make slow, precise moves, and `Alt` with the arrows turns
  precisely.
- The wheel zooms the lens; `Alt` with the wheel dollies.
- A click selects the figure under the aim dot, and `P` takes a snapshot.

## Interact mode

The app starts here. `Esc`, `Enter` (to type in the chat) or a window hotkey
switch to it, and holding `Ctrl` frees the mouse for as long as it is held.
Nothing covers the middle of the picture; panels sit at the edges:

- the selected figure, top left;
- Snapshot, Look and Help buttons, top centre;
- the camera rig diagram, top right;
- the chat, bottom left, showing the last two exchanges, with Undo, Redo and
  History buttons (History shows every exchange);
- the action bar at the bottom: the keys `1` to `9` pose the selected figure
  as Stand, Walk, Run, Sit, Crouch, Kneel, Point, Wave and Arms crossed, and
  `N` adds a figure, `G` moves it, `F` frames it and `Del` removes it. While
  moving, the figure follows the aim, the wheel turns it, a click or `G`
  drops it and `Esc` cancels.

A click on a figure selects it. A click on empty scene, or the Look button,
returns to look mode. Letting go of `Ctrl` while the cursor is over a panel
leaves the cursor free, so panels never need a Ctrl-click, which macOS treats
as a right-click.

Four windows open with keys: the Figure window (`C`), the Camera window (`V`),
the Scene window (`J`), which holds the scene as text, and the Settings window
(`O`). `H` shows the controls, and `Ctrl+Z` and `Ctrl+Shift+Z` undo and
redo. On touch devices, which have no pointer lock, dragging looks around and
a tap selects.

The Figure window sets the model, body type and body parameters, the pose and
its stride phase, hand shapes, placement, and every joint angle. A joint the
user has changed is highlighted as an override of the pose. The Scene window
shows the whole scene as editable text (see [architecture.md](architecture.md))
and holds the example scenes.

## Camera rig diagram

The camera panel is modeled on the camera diagrams of CAD and set-design tools
(`src/ui/cameraRig.ts`):

- **Top view**: figures with ticks showing their facing, props, the camera,
  the horizontal cone of the framed picture, the focus plane, the band in
  focus, and the distance to the subject.
- **Side view**, along the view direction: the ground, camera height and tilt,
  the vertical view cone, the horizon line at eye level, and figure silhouettes
  at their true height and distance.
- **Readouts**: lens, field of view, aperture, height, tilt, roll, distance to
  the subject, focus distance, and the range in focus (computed for a
  full-frame sensor). A plain-language shot name such as "High angle, medium
  shot of runner" or "Worm's-eye view" sits above them.

The diagram is also a control. Dragging the camera in the top view moves it,
and dragging anywhere else there aims it. Dragging the camera in the side view
changes its height, and dragging elsewhere tilts it. The wheel changes the
lens.

An optional horizon line on the picture marks the camera's eye level. It shows
while panels are visible, always, or never, as set in the Camera window. The
Camera window also sets focal length (for a 36 x 24 mm sensor), aperture and
blur, focus, roll, and the framing guides: a frame of a chosen aspect ratio
with lines at thirds. A snapshot (`P`) saves the framed region as a PNG
file named after the scene title and the time. Every camera change is recorded as a `camera` command, so it
can be undone.
