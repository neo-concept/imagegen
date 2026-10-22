import { envValue, fetchJson, parseDataUrl, UserError } from "./util.mjs";

const TIMEOUT_MS = Number(envValue("IMAGEGEN_TIMEOUT_SECONDS") ?? 300) * 1000;

function parseRatio(aspectRatio) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

// gpt-image models take pixel sizes, not aspect ratios.
// 1K maps to the fixed presets; 2K and 4K build a custom size within gpt-image-2 limits
// (edges multiple of 16, long edge <= 3840, ratio <= 3:1, at most 8,294,400 pixels).
export function openaiSize(aspectRatio, imageSize) {
  if (imageSize && /^\d+x\d+$/.test(imageSize)) return imageSize;
  const ratio = parseRatio(aspectRatio);
  if (!ratio) return aspectRatio || imageSize ? "auto" : "1024x1024";
  let [w, h] = ratio;
  const tier = (imageSize ?? "1K").toUpperCase();

  if (tier === "1K") {
    if (w === h) return "1024x1024";
    return w > h ? "1536x1024" : "1024x1536";
  }

  const longEdge = tier === "4K" ? 3840 : 2048;
  const r = Math.min(Math.max(w, h) / Math.min(w, h), 3);
  let long = longEdge;
  let short = long / r;
  const maxPixels = 8_294_400;
  if (long * short > maxPixels) {
    const scale = Math.sqrt(maxPixels / (long * short));
    long *= scale;
    short *= scale;
  }
  const snap = (v) => Math.max(16, Math.floor(v / 16) * 16);
  [long, short] = [snap(long), snap(short)];
  return w >= h ? `${long}x${short}` : `${short}x${long}`;
}

const gemini = {
  name: "gemini",
  defaultModel: "gemini-3.1-flash-image",
  apiKey: () => envValue("IMAGEGEN_GEMINI_API_KEY"),
  keyHint: "set the Gemini API key in the plugin options (https://aistudio.google.com/apikey)",

  async generate({ prompt, model, aspectRatio, imageSize, images, apiKey }) {
    const base = envValue("IMAGEGEN_GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta";
    const parts = [
      ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data.toString("base64") } })),
      { text: prompt },
    ];
    const imageConfig = {};
    if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
    if (imageSize) imageConfig.imageSize = imageSize.toUpperCase();
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
      },
    };

    let res;
    try {
      res = await fetchJson(
        `${base}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
        },
        "Gemini",
        TIMEOUT_MS,
      );
    } catch (err) {
      if (err.status === 429 && /limit: 0/.test(err.message)) {
        err.message +=
          "\nHint: the Gemini free tier has no quota for image models. Enable billing for the key's Google Cloud project, or use the openrouter provider.";
      }
      if (err.status === 400 && /location is not supported/i.test(err.message)) {
        err.message += "\nHint: the Gemini API is not available from your region. Set HTTPS_PROXY or use the openrouter provider.";
      }
      throw err;
    }

    const out = [];
    const notes = [];
    for (const candidate of res.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.inlineData?.data) {
          out.push({ mimeType: part.inlineData.mimeType, data: Buffer.from(part.inlineData.data, "base64") });
        } else if (part.text && !part.thought) {
          notes.push(part.text);
        }
      }
      if (!out.length && candidate.finishReason && candidate.finishReason !== "STOP") {
        notes.push(`finishReason: ${candidate.finishReason}`);
      }
    }
    if (res.promptFeedback?.blockReason) notes.push(`blocked: ${res.promptFeedback.blockReason}`);
    return { images: out, notes };
  },
};

const openai = {
  name: "openai",
  defaultModel: "gpt-image-2",
  apiKey: () => envValue("IMAGEGEN_OPENAI_API_KEY"),
  keyHint: "set the OpenAI API key in the plugin options (https://platform.openai.com/api-keys)",

  async generate({ prompt, model, aspectRatio, imageSize, images, apiKey, count, quality, background, outputFormat }) {
    const base = envValue("IMAGEGEN_OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
    const params = {
      model,
      prompt,
      n: count,
      size: openaiSize(aspectRatio, imageSize),
      ...(quality ? { quality } : {}),
      ...(background ? { background } : {}),
      ...(outputFormat ? { output_format: outputFormat } : {}),
    };
    const headers = { authorization: `Bearer ${apiKey}` };

    let init;
    let endpoint;
    if (images.length) {
      endpoint = `${base}/images/edits`;
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) form.append(key, String(value));
      for (const img of images) {
        form.append("image[]", new Blob([img.data], { type: img.mimeType }), img.path.split(/[\\/]/).pop());
      }
      init = { method: "POST", headers, body: form };
    } else {
      endpoint = `${base}/images/generations`;
      init = {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(params),
      };
    }

    const res = await fetchJson(endpoint, init, "OpenAI", TIMEOUT_MS);
    const mimeType = `image/${(outputFormat ?? res.output_format ?? "png").replace("jpg", "jpeg")}`;
    const out = (res.data ?? [])
      .filter((d) => d.b64_json)
      .map((d) => ({ mimeType, data: Buffer.from(d.b64_json, "base64") }));
    const notes = (res.data ?? []).map((d) => d.revised_prompt).filter(Boolean);
    return { images: out, notes, batched: true };
  },
};

const openrouter = {
  name: "openrouter",
  defaultModel: "google/gemini-3.1-flash-image",
  apiKey: () => envValue("IMAGEGEN_OPENROUTER_API_KEY"),
  keyHint: "set the OpenRouter API key in the plugin options (https://openrouter.ai/keys)",

  async generate({ prompt, model, aspectRatio, imageSize, images, apiKey }) {
    const base = envValue("IMAGEGEN_OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1";
    const content = images.length
      ? [
          { type: "text", text: prompt },
          ...images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mimeType};base64,${img.data.toString("base64")}` },
          })),
        ]
      : prompt;
    const imageConfig = {};
    if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
    if (imageSize) imageConfig.image_size = imageSize.toUpperCase();
    const body = {
      model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      ...(Object.keys(imageConfig).length ? { image_config: imageConfig } : {}),
    };

    const res = await fetchJson(
      `${base}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/neo-concept/imagegen",
          "X-Title": "imagegen for Claude Code",
        },
        body: JSON.stringify(body),
      },
      "OpenRouter",
      TIMEOUT_MS,
    );

    const out = [];
    const notes = [];
    for (const choice of res.choices ?? []) {
      for (const img of choice.message?.images ?? []) {
        const url = img.image_url?.url;
        if (url) out.push(parseDataUrl(url));
      }
      if (typeof choice.message?.content === "string" && choice.message.content.trim()) {
        notes.push(choice.message.content.trim());
      }
      if (!out.length && choice.finish_reason && choice.finish_reason !== "stop") {
        notes.push(`finish_reason: ${choice.finish_reason}`);
      }
    }
    if (typeof res.usage?.cost === "number") notes.push(`cost: $${res.usage.cost.toFixed(4)}`);
    return { images: out, notes };
  },
};

export const PROVIDERS = { gemini, openai, openrouter };
const AUTO_ORDER = ["gemini", "openai", "openrouter"];

function providerForModel(model) {
  if (!model) return undefined;
  if (model.includes("/")) return "openrouter";
  if (/^(gpt-image|dall-e|chatgpt-image)/i.test(model)) return "openai";
  if (/^(gemini|imagen)/i.test(model)) return "gemini";
  return undefined;
}

export function resolveProvider({ provider, model }) {
  let name = provider && provider !== "auto" ? provider : providerForModel(model);
  if (!name) {
    const preferred = envValue("IMAGEGEN_DEFAULT_PROVIDER")?.toLowerCase();
    if (preferred && preferred !== "auto") name = preferred;
  }
  if (!name) {
    name = AUTO_ORDER.find((n) => PROVIDERS[n].apiKey());
    if (!name) {
      throw new UserError(
        "No image provider is configured. Add at least one API key with /plugin configure imagegen@neo-concept " +
          "(or /plugin → imagegen → Configure options).",
      );
    }
  }
  const p = PROVIDERS[name];
  if (!p) throw new UserError(`Unknown provider "${name}". Use one of: ${Object.keys(PROVIDERS).join(", ")}`);
  const apiKey = p.apiKey();
  if (!apiKey) throw new UserError(`Provider "${name}" has no API key: ${p.keyHint}`);
  return { provider: p, apiKey, model: model || envValue(`IMAGEGEN_${name.toUpperCase()}_MODEL`) || p.defaultModel };
}

export function providerStatus() {
  const preferred = envValue("IMAGEGEN_DEFAULT_PROVIDER")?.toLowerCase() ?? "auto";
  return Object.values(PROVIDERS).map((p) => ({
    provider: p.name,
    configured: Boolean(p.apiKey()),
    defaultModel: envValue(`IMAGEGEN_${p.name.toUpperCase()}_MODEL`) || p.defaultModel,
    preferred: preferred === p.name,
  }));
}
