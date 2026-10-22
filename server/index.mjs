#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no dependencies,
// so the plugin works straight from a git checkout without npm install.
import { createInterface } from "node:readline";
import path from "node:path";
import { readFileSync } from "node:fs";
import { PROVIDERS, providerStatus, resolveProvider } from "./providers.mjs";
import { envValue, loadImage, saveImages, UserError } from "./util.mjs";

const VERSION = JSON.parse(
  readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
).version;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;

const baseDir = () => envValue("IMAGEGEN_PROJECT_DIR") ?? process.cwd();
const outputDir = () => path.resolve(baseDir(), envValue("IMAGEGEN_OUTPUT_DIR") ?? "generated-images");

const commonOptions = {
  provider: {
    type: "string",
    enum: ["auto", ...Object.keys(PROVIDERS)],
    description:
      "Image provider. auto (default) uses the configured default, else the first provider that has an API key: gemini, openai, openrouter.",
  },
  model: {
    type: "string",
    description:
      "Model id. Defaults: gemini → gemini-3.1-flash-image, openai → gpt-image-2, openrouter → google/gemini-3.1-flash-image. " +
      "A model id also picks the provider: ids with a slash go to OpenRouter, gpt-image-* to OpenAI, gemini-* to Gemini.",
  },
  aspect_ratio: {
    type: "string",
    description: 'Aspect ratio such as "1:1", "16:9", "9:16", "4:3", "3:2", "21:9".',
  },
  image_size: {
    type: "string",
    description: 'Resolution tier "1K", "2K" or "4K". For OpenAI an exact size like "1536x1024" is also accepted.',
  },
  count: {
    type: "integer",
    minimum: 1,
    maximum: 4,
    description: "Number of images to generate (default 1).",
  },
  output_path: {
    type: "string",
    description:
      "Where to save: a file path (e.g. assets/hero.png) or a directory. Relative paths resolve from the project root. " +
      "Default: generated-images/ with a timestamped name.",
  },
  quality: {
    type: "string",
    enum: ["auto", "low", "medium", "high"],
    description: "OpenAI only: rendering quality and cost.",
  },
  background: {
    type: "string",
    enum: ["auto", "transparent", "opaque"],
    description: "OpenAI only: transparent background (needs png or webp output).",
  },
  output_format: {
    type: "string",
    enum: ["png", "jpeg", "webp"],
    description: "OpenAI only: file format of the result.",
  },
  preview: {
    type: "boolean",
    description:
      "Also return the image itself so you can look at it (costs context tokens). Default false: only file paths are returned; use Read on a path to inspect it.",
  },
};

const TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate images from a text prompt with Gemini (Nano Banana), OpenAI gpt-image or any OpenRouter image model, and save them to disk. " +
      "Optional reference_images steer style or content. Returns the saved file paths.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw. Be specific about subject, style, composition, text in the image." },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description: "Optional paths to images used as references (style, subject, layout).",
        },
        ...commonOptions,
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    description:
      "Edit existing images with a natural-language instruction (change background, add or remove objects, restyle, combine several images). Saves the result to disk and returns the paths.",
    inputSchema: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Paths to the source images (png, jpg, webp). The first one is the main image.",
        },
        instruction: { type: "string", description: "What to change." },
        ...commonOptions,
      },
      required: ["images", "instruction"],
    },
  },
  {
    name: "list_providers",
    description: "Show which image providers have an API key configured and their default models.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function runGeneration(args, { prompt, imagePaths }) {
  if (!prompt || !String(prompt).trim()) throw new UserError("prompt must not be empty");
  const count = Math.min(Math.max(Number(args.count ?? 1) || 1, 1), 4);
  const { provider, apiKey, model } = resolveProvider({ provider: args.provider, model: args.model });
  const images = await Promise.all((imagePaths ?? []).map((p) => loadImage(p, baseDir())));

  const request = {
    prompt: String(prompt),
    model,
    apiKey,
    images,
    count,
    aspectRatio: args.aspect_ratio,
    imageSize: args.image_size,
    quality: args.quality,
    background: args.background,
    outputFormat: args.output_format,
  };

  // OpenAI returns n images in one call; the others generate one image per request.
  let results;
  const first = await provider.generate(request);
  if (first.batched || count === 1) {
    results = [first];
  } else {
    const rest = await Promise.all(Array.from({ length: count - 1 }, () => provider.generate(request)));
    results = [first, ...rest];
  }
  const generated = results.flatMap((r) => r.images);
  const notes = [...new Set(results.flatMap((r) => r.notes))];

  if (!generated.length) {
    throw new UserError(
      `${provider.name} (${model}) returned no image.` + (notes.length ? ` Provider said: ${notes.join(" | ")}` : ""),
    );
  }

  const saved = await saveImages(generated, {
    outputPath: args.output_path,
    outputDir: outputDir(),
    baseDir: baseDir(),
    prompt: String(prompt),
  });

  const lines = [
    `Generated ${saved.length} image${saved.length > 1 ? "s" : ""} with ${provider.name} (${model}):`,
    ...saved.map((s) => `- ${s.path} (${s.mimeType}, ${Math.round(s.bytes / 1024)} KB)`),
  ];
  if (saved.some((s) => s.extensionChanged)) {
    lines.push("", "Note: the provider returned a different format than the requested file extension, so the real extension was used.");
  }
  if (notes.length) lines.push("", "Provider notes:", ...notes.map((n) => `- ${n}`));

  const content = [{ type: "text", text: lines.join("\n") }];
  if (args.preview) {
    for (const [i, img] of generated.entries()) {
      if (img.data.length <= MAX_PREVIEW_BYTES) {
        content.push({ type: "image", data: img.data.toString("base64"), mimeType: img.mimeType });
      } else {
        content.push({ type: "text", text: `Preview skipped for ${saved[i].path}: larger than 3 MB.` });
      }
    }
  }
  return { content };
}

async function callTool(name, args = {}) {
  switch (name) {
    case "generate_image":
      return runGeneration(args, { prompt: args.prompt, imagePaths: args.reference_images });
    case "edit_image":
      if (!Array.isArray(args.images) || !args.images.length) throw new UserError("images must list at least one file");
      return runGeneration(args, { prompt: args.instruction, imagePaths: args.images });
    case "list_providers": {
      const rows = providerStatus().map(
        (s) => `- ${s.provider}: ${s.configured ? "configured" : "no API key"}, default model ${s.defaultModel}${s.preferred ? " (preferred)" : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: [`imagegen ${VERSION}`, ...rows, `Images are saved to ${outputDir()} unless output_path is given.`].join("\n"),
          },
        ],
      };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
        capabilities: { tools: {} },
        serverInfo: { name: "imagegen", version: VERSION },
        instructions:
          "Image generation and editing. Use generate_image for new images and edit_image to change existing files. " +
          "Results are saved to disk; pass output_path to put them where the project needs them.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      try {
        return await callTool(params?.name, params?.arguments);
      } catch (err) {
        if (err.code === -32602) throw err;
        if (!(err instanceof UserError)) process.stderr.write(`[imagegen] ${err.stack ?? err}\n`);
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function dispatch(message) {
  const isRequest = message && message.id !== undefined && message.method;
  try {
    const result = await handle(message);
    if (isRequest) send({ jsonrpc: "2.0", id: message.id, result });
  } catch (err) {
    if (isRequest) send({ jsonrpc: "2.0", id: message.id, error: { code: err.code ?? -32603, message: err.message } });
  }
}

const pending = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  for (const m of Array.isArray(message) ? message : [message]) {
    const task = dispatch(m).finally(() => pending.delete(task));
    pending.add(task);
  }
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
