import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// Claude Code leaves "${...}" in place when a plugin option or variable is unset.
export function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() && !value.startsWith("${")) return value.trim();
  }
  return undefined;
}

export class UserError extends Error {}

export async function loadImage(filePath, baseDir) {
  const resolved = path.resolve(baseDir, filePath);
  const mimeType = MIME_BY_EXT[path.extname(resolved).toLowerCase()];
  if (!mimeType) {
    throw new UserError(`Unsupported image type: ${filePath} (use png, jpg, webp or gif)`);
  }
  let data;
  try {
    data = await readFile(resolved);
  } catch (err) {
    throw new UserError(`Cannot read image ${resolved}: ${err.code ?? err.message}`);
  }
  return { path: resolved, mimeType, data };
}

export function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) throw new Error("Provider returned an image URL that is not a base64 data URL");
  return { mimeType: match[1], data: Buffer.from(match[2], "base64") };
}

function slugify(text) {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "image";
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

// outputPath may be a directory (ends with a separator or has no extension) or a file name.
// With several images and a file name, an index is appended before the extension.
export async function saveImages(images, { outputPath, outputDir, baseDir, prompt }) {
  let dir = outputDir;
  let stem = `${timestamp()}-${slugify(prompt)}`;
  let forcedExt;

  if (outputPath) {
    const resolved = path.resolve(baseDir, outputPath);
    const isDir = /[\\/]$/.test(outputPath) || !path.extname(resolved);
    if (isDir) {
      dir = resolved;
    } else {
      dir = path.dirname(resolved);
      forcedExt = path.extname(resolved);
      stem = path.basename(resolved, forcedExt);
    }
  }

  await mkdir(dir, { recursive: true });
  const saved = [];
  for (const [i, image] of images.entries()) {
    const actualExt = EXT_BY_MIME[image.mimeType] ?? ".png";
    // Keep the requested extension only if it matches the real format; never write JPEG bytes into a .png.
    const ext = forcedExt && MIME_BY_EXT[forcedExt.toLowerCase()] === image.mimeType ? forcedExt : actualExt;
    const suffix = images.length > 1 ? `-${i + 1}` : "";
    const file = path.join(dir, `${stem}${suffix}${ext}`);
    await writeFile(file, image.data);
    saved.push({
      path: file,
      mimeType: image.mimeType,
      bytes: image.data.length,
      extensionChanged: Boolean(forcedExt) && ext !== forcedExt,
    });
  }
  return saved;
}

export async function fetchJson(url, init, providerName, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`${providerName}: no response within ${timeoutMs / 1000}s`);
    }
    throw new Error(`${providerName}: network error: ${err.cause?.message ?? err.message}`);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.raw ?? response.statusText;
    const err = new Error(`${providerName} API error ${response.status}: ${message}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}
