# imagegen — image generation for Claude Code

Generate and edit images right from Claude Code with **your own API key**. No middleman server, no credits to buy: requests go straight from your machine to the provider you choose.

| Provider | Default model | Good at |
|---|---|---|
| **Google Gemini** (Nano Banana) | `gemini-3.1-flash-image` | fast, cheap, strong edits; `gemini-3-pro-image` for text in images |
| **OpenAI** | `gpt-image-2` | precise layouts, text rendering, transparent backgrounds |
| **OpenRouter** | `google/gemini-3.1-flash-image` | one key for many image models from different vendors |

Images are saved into your project (default `generated-images/`, or any `output_path` you ask for), so Claude can put them straight into your site, app or docs.

## Install

In Claude Code:

```
/plugin marketplace add neo-concept/imagegen
/plugin install imagegen@neo-concept
```

Claude Code asks for the plugin options when you enable it. Fill in at least one API key; the others can stay empty. Keys are stored in your system's secure credential store, not in `settings.json`. Change them later in `/plugin` → imagegen → Configure options.

The plugin reads keys only from these options. It does not pick up `GEMINI_API_KEY`, `OPENAI_API_KEY` or similar variables already set in your shell. From the command line: `claude plugin install imagegen@neo-concept --config openrouter_api_key=...`.

Requires Node.js 20 or newer on `PATH`. There are no npm dependencies to install.

## Use

Just ask:

> Make a 16:9 hero image for the landing page, a cozy coffee shop at dawn, flat illustration, save it to public/hero.png

> Generate 4 icon variants for a "sync" button, transparent background, with OpenAI

> Take assets/logo.png and make a dark-mode version of it

Claude uses three tools:

- `generate_image` — prompt, optional `reference_images`, `aspect_ratio` (`1:1`, `16:9`, `9:16`, …), `image_size` (`1K`, `2K`, `4K`), `count` (1–4), `output_path`, `provider`, `model`.
- `edit_image` — `images` (paths) and an `instruction`, same options.
- `list_providers` — shows which providers are configured.

OpenAI-only options: `quality` (`low`/`medium`/`high`), `background` (`transparent`/`opaque`), `output_format` (`png`/`jpeg`/`webp`).

Any OpenRouter model works by passing its id, for example `model: "openai/gpt-5-image"` or `model: "google/gemini-3-pro-image"`. A model id with a slash always goes to OpenRouter.

## Options

| Option | Default | Meaning |
|---|---|---|
| Gemini API key | — | [Google AI Studio](https://aistudio.google.com/apikey) key |
| OpenAI API key | — | [OpenAI platform](https://platform.openai.com/api-keys) key |
| OpenRouter API key | — | [OpenRouter](https://openrouter.ai/keys) key |
| Default provider | `auto` | `auto` uses the first provider with a key: gemini, openai, openrouter |
| Output directory | `generated-images` | where images go when no `output_path` is given |

Advanced environment variables: `IMAGEGEN_GEMINI_MODEL`, `IMAGEGEN_OPENAI_MODEL`, `IMAGEGEN_OPENROUTER_MODEL` override default models; `IMAGEGEN_OPENAI_BASE_URL` points the OpenAI provider at a compatible endpoint (also `IMAGEGEN_GEMINI_BASE_URL`, `IMAGEGEN_OPENROUTER_BASE_URL`); `IMAGEGEN_TIMEOUT_SECONDS` (default 300).

## Costs and gotchas

- **You pay the provider directly.** Typical prices: about $0.03–0.07 per image with Gemini Flash Image, $0.01–0.20 with gpt-image-2 depending on quality.
- **Gemini's free tier does not include image models.** A key without billing gets `429 … limit: 0`. Enable billing on the key's Google Cloud project, or use OpenRouter.
- **Regional restrictions.** Gemini and OpenAI block some countries. The server honours `HTTPS_PROXY` (on Node.js 22.21+ / 24+). OpenRouter is usually the easiest option there.
- Previews are off by default: tools return file paths, and Claude reads the file when it needs to look, which keeps base64 out of your context.

## Privacy and network access

The plugin runs a local MCP server (`node ${CLAUDE_PLUGIN_ROOT}/server/index.mjs`) and makes HTTPS requests only to the provider you select, with the key you configured for it:

| Provider | Endpoint | Sent |
|---|---|---|
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` | prompt, reference/source images |
| OpenAI | `https://api.openai.com/v1/images/generations`, `/v1/images/edits` | prompt, source images |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | prompt, reference/source images |

It reads only the image files you name, writes generated images into your project, and stores nothing else. There is no server of its own, no telemetry and no analytics. What each provider does with requests is governed by its own terms and privacy policy.

## Development

```
git clone https://github.com/neo-concept/imagegen
cd imagegen
npm test                         # offline tests against a mock API
claude --plugin-dir .            # try the plugin without installing it
claude plugin validate .
```

The MCP server is a single dependency-free Node.js file set under `server/`. Adding a provider means adding one adapter object to `server/providers.mjs`.

## License

MIT
