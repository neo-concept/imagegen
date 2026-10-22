import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openaiSize } from "../server/providers.mjs";

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let mock;
let mockUrl;
let workDir;
const requests = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "imagegen-test-"));
  mock = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (req.url.includes("quota-model")) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: "Quota exceeded for metric: x, limit: 0, model: quota-model" } }));
    } else if (req.url.includes(":generateContent")) {
      res.end(JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [
          { text: "Here you go" },
          { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } },
        ] } }],
      }));
    } else if (req.url.startsWith("/openai/images/")) {
      const n = req.url.endsWith("generations") ? JSON.parse(body).n : 1;
      res.end(JSON.stringify({ data: Array.from({ length: n }, () => ({ b64_json: PNG.toString("base64") })) }));
    } else if (req.url === "/openrouter/chat/completions") {
      res.end(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: null, images: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG.toString("base64")}` } },
        ] } }],
        usage: { cost: 0.0336 },
      }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
});

after(async () => {
  mock.close();
  await rm(workDir, { recursive: true, force: true });
});

function startServer(env) {
  const child = spawn(process.execPath, [path.resolve("server/index.mjs")], {
    env: {
      PATH: process.env.PATH,
      IMAGEGEN_PROJECT_DIR: workDir,
      IMAGEGEN_GEMINI_BASE_URL: `${mockUrl}/gemini`,
      IMAGEGEN_OPENAI_BASE_URL: `${mockUrl}/openai`,
      IMAGEGEN_OPENROUTER_BASE_URL: `${mockUrl}/openrouter`,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  return { child, rpc, call, stop: () => child.stdin.end() };
}

test("initialize and list tools", async () => {
  const s = startServer({});
  const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "imagegen");
  const list = await s.rpc("tools/list", {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ["generate_image", "edit_image", "list_providers"]);
  const unknown = await s.rpc("does/not/exist", {});
  assert.equal(unknown.error.code, -32601);
  s.stop();
});

test("reports a helpful error when no key is configured", async () => {
  const s = startServer({ IMAGEGEN_GEMINI_API_KEY: "${user_config.gemini_api_key}" });
  const res = await s.call("generate_image", { prompt: "cat" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No image provider is configured/);
  s.stop();
});

test("gemini: generates and saves to the default directory", async () => {
  const s = startServer({ IMAGEGEN_GEMINI_API_KEY: "g-key" });
  const res = await s.call("generate_image", { prompt: "A red cube", aspect_ratio: "16:9", image_size: "2k" });
  assert.equal(res.isError, undefined, res.content[0].text);
  const req = requests.at(-1);
  assert.equal(req.url, "/gemini/models/gemini-3.1-flash-image:generateContent");
  assert.equal(req.headers["x-goog-api-key"], "g-key");
  const body = JSON.parse(req.body);
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" });
  const files = await readdir(path.join(workDir, "generated-images"));
  assert.ok(files.some((f) => f.endsWith("-a-red-cube.png")), files.join(","));
  assert.match(res.content[0].text, /Here you go/);
  s.stop();
});

test("gemini: explains a zero free-tier quota", async () => {
  const s = startServer({ IMAGEGEN_GEMINI_API_KEY: "g-key" });
  const res = await s.call("generate_image", { prompt: "x", model: "gemini-quota-model" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Enable billing/);
  s.stop();
});

test("openai: batches count into one request and honours output_path", async () => {
  const s = startServer({ IMAGEGEN_OPENAI_API_KEY: "o-key" });
  const res = await s.call("generate_image", {
    prompt: "logo", provider: "openai", count: 2, aspect_ratio: "16:9", output_path: "assets/logo.png", background: "transparent",
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const req = requests.at(-1);
  assert.equal(req.url, "/openai/images/generations");
  assert.equal(req.headers.authorization, "Bearer o-key");
  const body = JSON.parse(req.body);
  assert.equal(body.n, 2);
  assert.equal(body.size, "1536x1024");
  assert.equal(body.background, "transparent");
  const files = (await readdir(path.join(workDir, "assets"))).sort();
  assert.deepEqual(files, ["logo-1.png", "logo-2.png"]);
  s.stop();
});

test("openai: edit sends multipart with image[]", async () => {
  const src = path.join(workDir, "src.png");
  await writeFile(src, PNG);
  const s = startServer({ IMAGEGEN_OPENAI_API_KEY: "o-key" });
  const res = await s.call("edit_image", { images: ["src.png"], instruction: "make it blue", model: "gpt-image-2", output_path: "out/" });
  assert.equal(res.isError, undefined, res.content[0].text);
  const req = requests.at(-1);
  assert.equal(req.url, "/openai/images/edits");
  assert.match(req.headers["content-type"], /^multipart\/form-data/);
  const text = req.body.toString("latin1");
  assert.match(text, /name="image\[\]"; filename="src.png"/);
  assert.match(text, /name="prompt"\r\n\r\nmake it blue/);
  assert.equal((await readdir(path.join(workDir, "out"))).length, 1);
  s.stop();
});

test("openrouter: picked by a slash model id, decodes data URLs, runs count requests", async () => {
  const s = startServer({ IMAGEGEN_OPENROUTER_API_KEY: "r-key", IMAGEGEN_GEMINI_API_KEY: "g-key" });
  const before = requests.length;
  const res = await s.call("generate_image", {
    prompt: "sunset", model: "google/gemini-3-pro-image", count: 2, output_path: "or/", preview: true,
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const sent = requests.slice(before);
  assert.equal(sent.length, 2);
  const body = JSON.parse(sent[0].body);
  assert.equal(body.model, "google/gemini-3-pro-image");
  assert.deepEqual(body.modalities, ["image", "text"]);
  const files = await readdir(path.join(workDir, "or"));
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => f.endsWith(".jpg")));
  assert.equal(res.content.filter((c) => c.type === "image").length, 2);
  assert.match(res.content[0].text, /cost: \$0\.0336/);
  const renamed = await s.call("generate_image", { prompt: "x", model: "google/gemini-3-pro-image", output_path: "or2/pic.png" });
  assert.deepEqual(await readdir(path.join(workDir, "or2")), ["pic.jpg"]);
  assert.match(renamed.content[0].text, /real extension was used/);
  const saved = await readFile(path.join(workDir, "or", files[0]));
  assert.deepEqual(saved, PNG);
  s.stop();
});

test("list_providers shows configuration", async () => {
  const s = startServer({ IMAGEGEN_OPENROUTER_API_KEY: "r-key", IMAGEGEN_DEFAULT_PROVIDER: "openrouter" });
  const res = await s.call("list_providers", {});
  assert.match(res.content[0].text, /openrouter: configured, default model google\/gemini-3.1-flash-image \(preferred\)/);
  assert.match(res.content[0].text, /gemini: no API key/);
  s.stop();
});

test("openaiSize maps ratios and tiers", () => {
  assert.equal(openaiSize(undefined, undefined), "1024x1024");
  assert.equal(openaiSize("9:16", "1K"), "1024x1536");
  assert.equal(openaiSize("16:9", "2K"), "2048x1152");
  assert.equal(openaiSize("16:9", "4K"), "3840x2160");
  assert.equal(openaiSize("1:1", "4K"), "2880x2880");
  assert.equal(openaiSize("1:1", "1792x1024"), "1792x1024");
  for (const [r, t] of [["21:9", "4K"], ["3:4", "2K"], ["1:5", "4K"]]) {
    const [w, h] = openaiSize(r, t).split("x").map(Number);
    assert.equal(w % 16, 0);
    assert.equal(h % 16, 0);
    assert.ok(w * h <= 8_294_400);
    assert.ok(Math.max(w, h) / Math.min(w, h) <= 3.01);
  }
});
