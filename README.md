# Simposer

A prototype web app for setting up posed 3D figures as drawing reference. You
describe a scene in plain language, such as "a teenaged girl running against
a crowd of passers-by who are walking", and refine it the same way ("raise her
right hand to cover her face"). A language model translates each request into
a short script of high-level commands. The app applies the script to the
scene and renders it, with a camera you walk around and set up like a
photographer's.

```
[natural language] --LLM--> [delta DSL] --apply--> [scene document] --solve + render--> [picture]
```

A DSL (domain-specific language) is a small language made for one job. The
delta DSL is a list of edits ("add a figure", "put her right hand on her
face"). The scene document is written out as text too, the scene DSL, using
the same commands. Solving turns each figure's pose into bone rotations that
rest its feet, seat or body on the floor or a seat. Only the language model can give different
results for the same input. The rest is deterministic, and both script formats
are meant to be read and edited by people. Poses are composed in a small
language, so a walk can keep its legs and swap its feet for tiptoes, or carry
a phone in one hand.

## Running

```
pnpm install
node tools/fetch-makehuman.mjs    # CC0 MakeHuman source data into vendor/ (git-ignored)
node tools/build-makehuman.mjs    # writes public/models/makehuman/kit.json and kit.bin
pnpm dev                          # http://localhost:5173
pnpm build                        # static site in dist/
pnpm typecheck
```

The two `tools/` steps download the MakeHuman data and pack it into the kit,
the compact pair of files the app loads the human figure from. If
`public/models/makehuman/kit.json` and `kit.bin` already exist, skip them; run
them again only if `build-makehuman.mjs` changes. The kit is CC0, so it can be
committed with the app.

The app is a progressive web app (PWA): once loaded, it can be installed and
used offline. Its service worker is registered only in production builds.

### Hosting on GitHub Pages

`.github/workflows/pages.yml` builds the app and publishes `dist/` on every
push to `main`, or when run by hand from the Actions tab. To turn it on, set
the repository's Settings > Pages > Build and deployment > Source to "GitHub
Actions". The site appears at `https://<user>.github.io/<repo>/`. The build
uses relative URLs, so it works under any repository name or a custom domain.

The workflow uses Node 24 and pnpm 12.14.0, and installs from the lockfile. The MakeHuman kit in
`public/models/makehuman/` must be committed, since the workflow does not run
the `tools/` scripts.

Each build names the service worker's cache after a hash of the built files,
so visitors get the new files after a deployment changes them. See
[llm.md](docs/llm.md) for using local language models from the hosted page.

No language model is needed to try the app. Whatever is typed into the chat
(press `Enter`) is first tried as commands, such as
`add amy body adult_female pose walk`: if every line parses and applies, it
is applied directly; otherwise it goes to the language model. The app starts
with the mouse free and panels shown; clicking the scene captures the mouse
to look around, and `Esc` frees it again. The Scene window (`J`) has example
scenes. To use natural language, choose a provider in
the Settings window (`O`): Ollama, any OpenAI-compatible server (LM Studio,
llama.cpp, vLLM) or Anthropic.

## Rendering and body options

The scene has a sun with adjustable direction and intensity, a fill light and
shadows. For artists who paint light and shadow as planes, the scene command
`style flat` shows faceted surfaces and `style toon` a three-tone ramp.

Each figure has a body preset (`adult_female`, `child`, `elderly`,
`anime_female`, `chibi` and others) and continuous parameters: `age`,
`femininity`, `height`, `build` (weight), `muscle`, `bust` and `hip`. They are
set with sliders or with commands such as `body amy age 40`, for a figure
named `amy`. For cartoon proportions, `heads` sets the figure's height in head
lengths and `leg_length` scales the legs.

## Documentation

The design is documented in [`docs/`](docs/README.md):

- [Architecture](docs/architecture.md): the pipeline, the delta and scene DSLs,
  undo, modules.
- [Pose system](docs/pose-system.md): the pose language, the default library
  and the gaits.
- [Posing and contact](docs/posing-and-contact.md): rigs, skinning,
  self-collision and ground contact.
- [Figures](docs/figures.md): the MakeHuman figure and other models.
- [Interface](docs/interface.md): controls and the camera rig diagram.
- [Language models](docs/llm.md): providers, translation and local model
  measurements.
- [DSL reference](docs/dsl-reference.md): the command and pose reference given
  to language models.
