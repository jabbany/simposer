# Language models

A language model turns a request in natural language into delta DSL. It is the
only part of Simposer that needs one, and the app works without it: typed DSL
lines are applied directly.

## Providers

All providers implement one interface in `src/llm/providers.ts`: a system
prompt and messages go in, text comes out. A model running in the browser,
such as one served by WebLLM or transformers.js, would be another
implementation of the same interface.

| Provider | Notes |
| --- | --- |
| Ollama (native API) | Local. Sets the context size per request and turns off "thinking" output. |
| OpenAI-compatible | LM Studio, the llama.cpp server, vLLM, or hosted endpoints. |
| Anthropic | The Messages API, called from the browser with the user's key, which is kept in `localStorage`. |

The provider is chosen in the Settings window (`O`), with three fields:

| Provider | model (default) | base URL (default) | API key |
| --- | --- | --- | --- |
| Ollama | `qwen3:8b` | `http://localhost:11434` | not needed |
| OpenAI-compatible | the model name the server lists | `http://localhost:1234/v1` (LM Studio) | if the server needs one |
| Anthropic | `claude-opus-5-5` | `https://api.anthropic.com` | required |

To call LM Studio running on another machine, use that machine's address in
the base URL and enable CORS in LM Studio's server settings.

From the hosted page on GitHub Pages, which is served over https:

- Ollama accepts requests only from origins it is told to allow. Start it
  with `OLLAMA_ORIGINS` set to the page's origin, for example
  `OLLAMA_ORIGINS=https://<user>.github.io ollama serve`.
- Browsers block requests from an https page to plain http addresses (mixed
  content). Chrome and Firefox make an exception for `localhost`, so a model
  server on the same machine works there; other browsers may not allow it. A
  server on another machine needs https, or the app can be run locally with
  `pnpm dev` instead.
- The Anthropic provider works as it does locally.

## Translation

`src/llm/translate.ts` builds the request:

- **System prompt** (`src/llm/prompt.ts`), generated from the vocabulary and the
  pose library: every command, joint and motion, body part, body preset,
  whole-body pose with its slots, the pose parts that fill each slot, and the
  pose atoms. Since the parser reads the same tables, the prompt only
  describes syntax the parser accepts. It is about 8,500 characters.
- **Context**: the current scene as scene text, and the last three requests
  with the deltas they produced.

The reply is parsed and applied to a copy of the scene. If either step fails,
the errors go back to the model as a new message, up to two times. The chat
shows the final delta and how many attempts it took.

[dsl-reference.md](dsl-reference.md) is a complete reference for the command
and pose language, written to be given to a model.

## Request settings

- **Reasoning off.** Reasoning tokens count against the reply's token limit,
  and a reasoning model can spend the whole budget before it writes an answer.
  The OpenAI-compatible provider sends `reasoning_effort: "none"` (LM Studio
  honours it) and the Ollama provider sends `think: false`. The Anthropic
  provider asks for low effort instead.
- **Constrained output.** The Ollama and OpenAI-compatible providers pass a
  JSON schema, `{"commands": [string]}`, as Ollama's `format` or as
  `response_format`, so the model cannot mix prose into the commands. Each
  string becomes one or more lines of the delta; a `define pose` block can be
  one string with line breaks or one string per line.
- **Fallback.** Not every OpenAI-compatible server accepts
  `reasoning_effort` and `response_format`. If the server answers with HTTP
  400, the provider drops `reasoning_effort`, then `response_format`, and
  sends the request again each time.
- **Context size.** Ollama's default context of 4,096 tokens is too small for
  the prompt, so the Ollama provider sets `num_ctx` for each request: an
  estimate of the prompt's tokens plus the reply limit and a margin, rounded
  up to a multiple of 2,048 and at least 4,096.
- **Reply limit.** Replies are capped at 1,200 tokens.

Replies that are not this JSON object, such as all Anthropic replies, are
plain text, and some models mix prose into them. From plain text, the
extractor takes the last fenced code block if there is one, and otherwise
keeps only lines that start with a command word, plus the body lines of
`define pose` blocks.

## Local model findings (2026-11-19)

The test is a local script, not part of the repository. It sends four chained
requests, starting from "a teenaged female running against a crowd of passers
by who are walking", through the app's own translation and validation code,
run in Node.

| Model | Valid on first try | Time per request | Notes |
| --- | --- | --- | --- |
| qwen/qwen3.6-35b-a3b (MoE), LM Studio on the LAN | 4 of 4 | 1.5-2 s | Gave the crowd `facing random` instead of walking against her; added `set` lines that `reach` and `look` then overrode. |
| google/gemma-4-31b-qat, LM Studio on the LAN | 4 of 4 | 35-64 s | The most precise: `facing 180` for "against", few `reach` and `look` lines, used `camera orbit`. |
| qwen3:30b, Ollama on a 24 GB laptop | 0 of 2 requests, then 2 of 2 with constrained output | 45-55 s | Weak semantics, such as raising both legs. |

What the tests showed about the settings above:

- Before reasoning was turned off, one LM Studio model returned empty replies
  because its reasoning used up the token limit. With it off, requests were
  about ten times faster.
- Before output was constrained, models mixed prose ("Okay, wait, so...") into
  the command list.
- The repair loop was not needed in the LM Studio runs; it is there for weaker
  models.

A mid-size model on a local machine is enough for this translation, and the
validator catches its syntax errors. The remaining errors are about meaning,
such as not reading "against" as "facing the opposite way"; better examples in
the prompt should help with those. The next test is a model small enough for
the browser, with 1 to 4 billion parameters.

The tests ran before the pose language added `define pose`, slots and blends
to the prompt, and have not been repeated since.
