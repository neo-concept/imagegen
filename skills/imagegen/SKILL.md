---
name: imagegen
description: Generate or edit images (illustrations, icons, logos, hero images, mockups, textures, social cards, photos) with the imagegen MCP tools. Use when the user asks to draw, generate, create, render or edit a picture or image asset, or when a project needs an image file that does not exist yet.
---

# Image generation with imagegen

Tools from the `imagegen` MCP server:

- `generate_image` — new image from a prompt, optionally guided by `reference_images`.
- `edit_image` — change existing image files with an instruction.
- `list_providers` — which providers have keys and their default models.

## Workflow

1. If you are unsure whether anything is configured, call `list_providers` first. If no provider has a key, tell the user to open `/plugin`, select imagegen and configure its options, or to export `GEMINI_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`.
2. Write a concrete prompt: subject, style or medium, composition and camera, lighting, color palette, and any exact text that must appear (in quotes). Mention what to avoid only when it matters.
3. Save where the project needs the file: pass `output_path`, e.g. `public/images/hero.webp` or `assets/icons/`. Without it, files land in `generated-images/`.
4. Pick `aspect_ratio` to match the use: `16:9` banners and heroes, `1:1` icons and avatars, `9:16` mobile and stories, `4:3` or `3:2` illustrations.
5. After generating, Read the saved file to check it before telling the user it is done, unless they asked for speed. Use `edit_image` on the saved file for corrections instead of regenerating from scratch.

## Choosing a provider

- Default (`auto`) is fine for most requests.
- Text rendered inside the image, infographics, precise layouts: Gemini `gemini-3-pro-image` or OpenAI `gpt-image-2`.
- Transparent background (logos, stickers, sprites): OpenAI with `background: "transparent"` and `output_format: "png"`.
- Fast drafts and many variations: Gemini `gemini-3.1-flash-image` (the default), with `count` up to 4.
- Any other model on OpenRouter: pass its full id, e.g. `model: "google/gemini-3-pro-image"`.

Each image costs the user money on their own API account. Do not generate more images than asked, and ask before batches larger than 4.
