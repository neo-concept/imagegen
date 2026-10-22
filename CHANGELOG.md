# Changelog

## 0.1.3 — 2026-10-22

- Display name "Neo ImageGen", distinct from other image plugins in the directory.
- README no longer names environment credential variables.

## 0.1.2 — 2026-10-22

- Default provider option is free text (directory requirement for options referenced from the MCP config).

## 0.1.1 — 2026-10-22

- API keys are read only from the plugin options, not from `GEMINI_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in the environment.
- Plugin icon.
- README lists every network endpoint the plugin calls.

## 0.1.0 — 2026-10-22

- First release.
- `generate_image`, `edit_image` and `list_providers` MCP tools.
- Providers: Google Gemini (Nano Banana), OpenAI gpt-image, OpenRouter.
- API keys as sensitive plugin options or environment variables.
- Images saved to the project, with aspect ratio, resolution tier and count options.
