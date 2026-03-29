import http from "http";
import url from "url";
import crypto from "crypto";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ========== CONFIG & CONSTANTS ==========

const PORT = parseInt(process.env.PORT || "11434", 10);
const LMSTUDIO_URL = process.env.LMSTUDIO_URL || "http://localhost:1234";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const LOG_FILE = process.env.LOG_FILE || "./traffic.log";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "300000", 10); // 5 min

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logPath = path.resolve(__dirname, LOG_FILE);

// Parse CLI flags
const VERBOSE = process.argv.includes("--verbose");
const LOGGING = process.argv.includes("--log");
const OLLAMA_SHOW = process.argv.includes("--ollama_show");
const SHOW_HELP = process.argv.includes("--help");

// Help text
if (SHOW_HELP) {
  console.log(`
Usage: node vscode_lms_proxy.mjs [options]

Options:
  --log         Enable traffic logging to file (default: disabled)
  --verbose     Enable verbose console output (default: disabled)
  --ollama_show Use Ollama server for /api/show endpoint (default: synthetic)
  --help        Show this help message

Environment Variables:
  PORT           Server port (default: 11434)
  LMSTUDIO_URL   LMStudio server URL (default: http://localhost:1234)
  OLLAMA_URL     Remote Ollama URL (default: http://localhost:11434)
  LOG_FILE       Log file path (default: ./traffic.log)
  TIMEOUT_MS     Request timeout in ms (default: 300000)

Examples:
  node vscode_lms_proxy.mjs                    # Silent mode
  node vscode_lms_proxy.mjs --log              # Logging enabled
  node vscode_lms_proxy.mjs --verbose          # Console output
  node vscode_lms_proxy.mjs --log --verbose    # Full debug mode
  `);
  process.exit(0);
}

// Detect local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}
const LOCAL_IP = getLocalIP();

// Model cache (TTL: 5 minutes)
let modelCache = null;
let modelCacheTime = 0;
const MODEL_CACHE_TTL = 5 * 60 * 1000;

console.log("");
console.log("========== VSCODE LMS PROXY v2.0 ==========");
console.log(`Proxy URL:        http://${LOCAL_IP}:${PORT}`);
console.log(`LMStudio Server:  ${LMSTUDIO_URL}`);
console.log(`Ollama Server:    ${OLLAMA_URL}`);
console.log(`Traffic Log:      ${LOGGING ? logPath : "DISABLED"}`);
console.log(`Verbose Output:   ${VERBOSE ? "ON" : "OFF"}`);
console.log(`/api/show Mode:   ${OLLAMA_SHOW ? "OLLAMA_SHOW" : "SYNTHETIC"}`);
console.log("=========================================");
console.log("");

// ========== LOGGER MODULE ==========

function createLogger(flags = {}) {
  const { verbose = VERBOSE, logging = LOGGING } = flags;

  return {
    traffic(entry) {
      const timestamp = new Date().toISOString();
      const logEntry = { timestamp, ...entry };
      const logLine = JSON.stringify(logEntry) + "\n";

      if (logging) {
        try {
          fs.appendFileSync(logPath, logLine, "utf-8");
        } catch (err) {
          console.error("[ERROR] Failed to write log:", err.message);
        }
      }

      if (verbose) {
        console.log(`[TRAFFIC]`, entry.type || "");
      }
    },

    info(msg) {
      console.log(msg);
    },

    error(msg) {
      console.error("[ERROR]", msg);
    },

    warn(msg) {
      console.warn("[WARN]", msg);
    }
  };
}

const logger = createLogger();

// ========== MODELS CACHE & RESOLUTION ==========

async function fetchLMStudioModels() {
  const now = Date.now();

  if (modelCache && now - modelCacheTime < MODEL_CACHE_TTL) {
    return modelCache;
  }

  try {
    const res = await fetch(`${LMSTUDIO_URL}/api/v1/models`, {
      timeout: TIMEOUT_MS
    });

    if (!res.ok) {
      throw new Error(`LMStudio returned ${res.status}`);
    }

    const data = await res.json();
    modelCache = data.models || [];
    modelCacheTime = now;

    return modelCache;
  } catch (err) {
    logger.error(`Failed to fetch models from LMStudio: ${err.message}`);
    throw err;
  }
}

async function resolveModelKey(displayName) {
  try {
    const models = await fetchLMStudioModels();
    const match = models.find(
      (m) => m.display_name === displayName || m.key === displayName
    );

    if (!match) {
      const err = new Error(`model not found: ${displayName}`);
      err.name = "NotFoundError";
      throw err;
    }

    return match;
  } catch (err) {
    if (err.name === "NotFoundError") throw err;
    const newErr = new Error(`Failed to resolve model: ${err.message}`);
    newErr.name = "NetworkError";
    throw newErr;
  }
}

function generateDigest(modelKey) {
  return crypto.createHash("sha256").update(modelKey).digest("hex");
}

// ========== ADAPTERS & HELPERS ==========

function createStreamConverter(mode) {
  const converters = {
    ndjson: {
      onData: (chunk, state) => {
        state.buffer += chunk.toString();
        const lines = state.buffer.split("\n");
        state.buffer = lines.pop() || "";

        const outputs = [];
        for (const line of lines) {
          if (!line || !line.startsWith("data:")) continue;

          const payload = line.replace("data:", "").trim();
          if (payload === "[DONE]") {
            const msg = {
              model: state.model,
              message: { role: "assistant", content: "" },
              done: true,
              created_at: new Date().toISOString()
            };
            outputs.push(JSON.stringify(msg) + "\n");
            state.chunkCount++;
            if (VERBOSE) console.log(`[STREAM] ndjson chunk ${state.chunkCount}: done=true`);
            continue;
          }

          try {
            const json = JSON.parse(payload);
            const delta = json.choices?.[0]?.delta?.content;
            const finishReason = json.choices?.[0]?.finish_reason;

            if (delta !== undefined || finishReason === "stop") {
              const msg = {
                model: state.model,
                message: { role: "assistant", content: delta || "" },
                done: finishReason === "stop",
                created_at: new Date().toISOString()
              };
              outputs.push(JSON.stringify(msg) + "\n");
              state.chunkCount++;
            }
          } catch (e) {
            if (VERBOSE) console.warn("[WARN] Failed to parse SSE payload:", e.message);
          }
        }
        return outputs.join("");
      },

      onEnd: (state) => {
        logger.traffic({
          type: "RESPONSE",
          status: 200,
          path: state.path,
          streamChunks: state.chunkCount,
          done: true
        });
        console.log(`[STREAM] ${state.path} completed: ${state.chunkCount} chunks`);
      }
    },

    sse: {
      onData: (chunk, state) => {
        state.chunkCount++;
        return chunk;
      },

      onEnd: (state) => {
        logger.traffic({
          type: "RESPONSE",
          status: 200,
          path: state.path,
          streamChunks: state.chunkCount,
          done: true
        });
        console.log(`[STREAM] ${state.path} completed: ${state.chunkCount} chunks`);
      }
    }
  };

  return converters[mode] || converters.sse;
}

function setStreamHeaders(res, format = "ndjson") {
  if (format === "ndjson") {
    res.setHeader("Content-Type", "application/x-ndjson");
  } else if (format === "sse") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }
}

async function pipeStream(sourceStream, res, converter, state) {
  try {
    for await (const chunk of sourceStream) {
      const output = converter.onData(chunk, state);
      if (output) res.write(output);
    }
    converter.onEnd(state);
    res.end();
  } catch (err) {
    logger.error(`Stream error on ${state.path}: ${err.message}`);
    logger.traffic({ type: "ERROR", path: state.path, error: err.message });
    throw err;
  }
}

async function parseBody(req) {
  if (req.method === "GET" || req.method === "OPTIONS") {
    return null;
  }

  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

// ========== HANDLERS ==========

async function versionHandler(req, res) {
  console.log("[HANDLER] GET /api/version");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ version: "0.18.3" }));
}

async function tagsHandler(req, res) {
  console.log("[HANDLER] GET /api/tags");

  try {
    const lmModels = await fetchLMStudioModels();
    const models = lmModels
      .map((m) => ({
        name: m.display_name,
        model: m.display_name,
        modified_at: new Date().toISOString(),
        size: m.size_bytes || 0,
        digest: generateDigest(m.key),
        details: {
          parent_model: "",
          format: m.format || "gguf",
          family: m.architecture || "unknown",
          families: [m.architecture || "unknown"],
          parameter_size: m.parameters || "N/A",
          quantization_level: m.quantization?.name || "unknown"
        }
      }))
      .filter((m) => m !== null);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models }));
  } catch (err) {
    logger.error(`/api/tags failed: ${err.message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to fetch models from LMStudio" }));
  }
}

async function showHandler(req, res) {
  const model = req.body?.model || req.body?.name;
  console.log(`[HANDLER] POST /api/show for model: ${model}`);

  if (!model) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "model is required" }));
    return;
  }

  try {
    if (!OLLAMA_SHOW) {
      const lmModel = await resolveModelKey(model);
      const capabilities = ["completion"];
      if (lmModel.capabilities?.trained_for_tool_use) {
        capabilities.push("tools", "thinking");
      }

      let modelDetails;
      try {
        const detailRes = await fetch(`${LMSTUDIO_URL}/api/v0/models/${lmModel.key}`, {
          timeout: TIMEOUT_MS
        });
        if (detailRes.ok) {
          modelDetails = await detailRes.json();
        }
      } catch (err) {
        logger.warn(`Could not fetch detailed model info: ${err.message}`);
      }

      const architecture = modelDetails?.arch || lmModel.key;
      const contextLength = modelDetails?.max_context_length || 655536;

      const response = {
        capabilities,
        model_info: {
          "general.architecture": architecture,
          [`${architecture}.context_length`]: contextLength
        }
      };

      if (VERBOSE) console.log(`[SYNTHETIC] ${lmModel.display_name}, arch=${architecture}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    // OLLAMA PASSTHROUGH MODE
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      timeout: TIMEOUT_MS
    });

    if (!ollamaRes.ok) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "model not found" }));
      return;
    }

    const data = await ollamaRes.json();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    logger.error(`/api/show failed: ${err.message}`);
    if (err.name === "NotFoundError") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to fetch model details" }));
    }
  }
}

async function chatHandler(req, res) {
  const { model, messages } = req.body;
  console.log(`[HANDLER] POST /api/chat for model: ${model}`);

  if (!model || !messages) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "model and messages are required" }));
    return;
  }

  try {
    const lmModel = await resolveModelKey(model);
    const lmRes = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: lmModel.key, messages, stream: true }),
      timeout: TIMEOUT_MS
    });

    if (!lmRes.ok) throw new Error(`LMStudio returned ${lmRes.status}`);

    setStreamHeaders(res, "ndjson");
    const converter = createStreamConverter("ndjson");
    const state = { model, path: "/api/chat", buffer: "", chunkCount: 0 };

    await pipeStream(lmRes.body, res, converter, state);
  } catch (err) {
    logger.error(`/api/chat failed: ${err.message}`);
    const statusCode = err.name === "NotFoundError" ? 404 : 502;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Failed to connect to LMStudio" }));
  }
}

async function generateHandler(req, res) {
  const { model, prompt } = req.body;
  console.log(`[HANDLER] POST /api/generate for model: ${model}`);

  if (!model || !prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "model and prompt are required" }));
    return;
  }

  try {
    const lmModel = await resolveModelKey(model);
    const lmRes = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: lmModel.key,
        messages: [{ role: "user", content: prompt }],
        stream: true
      }),
      timeout: TIMEOUT_MS
    });

    if (!lmRes.ok) throw new Error(`LMStudio returned ${lmRes.status}`);

    setStreamHeaders(res, "ndjson");
    const converter = createStreamConverter("ndjson");
    const state = { model, path: "/api/generate", buffer: "", chunkCount: 0 };

    await pipeStream(lmRes.body, res, converter, state);
  } catch (err) {
    logger.error(`/api/generate failed: ${err.message}`);
    const statusCode = err.name === "NotFoundError" ? 404 : 502;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Failed to connect to LMStudio" }));
  }
}

async function chatCompletionsHandler(req, res) {
  const { model, messages, stream } = req.body;
  console.log(`[HANDLER] POST /v1/chat/completions for model: ${model}`);

  if (!model || !messages) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "model and messages are required" }));
    return;
  }

  try {
    const lmModel = await resolveModelKey(model);
    const shouldStream = stream === true;

    const lmRes = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, model: lmModel.key, stream: shouldStream }),
      timeout: TIMEOUT_MS
    });

    if (!lmRes.ok) throw new Error(`LMStudio returned ${lmRes.status}`);

    if (shouldStream) {
      setStreamHeaders(res, "sse");
      const converter = createStreamConverter("sse");
      const state = { model, path: "/v1/chat/completions", chunkCount: 0 };

      await pipeStream(lmRes.body, res, converter, state);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunks = [];
      for await (const chunk of lmRes.body) {
        chunks.push(chunk);
      }
      const responseBuffer = Buffer.concat(chunks);
      const responseData = JSON.parse(responseBuffer.toString("utf-8"));

      logger.traffic({
        type: "RESPONSE",
        status: 200,
        path: "/v1/chat/completions",
        bodyLength: responseBuffer.length,
        done: true
      });
      console.log(`[RESPONSE] /v1/chat/completions non-streaming: ${responseBuffer.length} bytes`);

      res.end(JSON.stringify(responseData));
    }
  } catch (err) {
    logger.error(`/v1/chat/completions failed: ${err.message}`);
    const statusCode = err.name === "NotFoundError" ? 404 : 502;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Failed to connect to LMStudio" }));
  }
}

// ========== ROUTER ==========

function createRouter() {
  const routes = new Map();

  return {
    register(method, pathname, handler) {
      routes.set(`${method.toUpperCase()} ${pathname}`, handler);
    },

    getHandler(method, pathname) {
      return routes.get(`${method.toUpperCase()} ${pathname}`);
    }
  };
}

const router = createRouter();

// ========== HTTP SERVER ==========

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

  try {
    const body = await parseBody(req);
    req.body = body;
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const handler = router.getHandler(req.method, pathname);

  if (!handler) {
    console.log(`[404] Unknown endpoint: ${req.method} ${pathname}`);
    logger.traffic({ type: "RESPONSE", status: 404, path: pathname, error: "Not found" });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error("[ERROR] Uncaught exception:", err.message);
    logger.traffic({ type: "ERROR", path: pathname, error: err.message });

    const statusCode = err.name === "NotFoundError" ? 404 : (err.name === "NetworkError" ? 502 : 500);
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal server error" }));
  }
});

router.register("GET", "/api/version", versionHandler);
router.register("GET", "/api/tags", tagsHandler);
router.register("POST", "/api/show", showHandler);
router.register("POST", "/api/chat", chatHandler);
router.register("POST", "/api/generate", generateHandler);
router.register("POST", "/v1/chat/completions", chatCompletionsHandler);

// ========== STARTUP ==========

async function start() {
  try {
    const models = await fetchLMStudioModels();
    console.log(`[STARTUP] Connected to LMStudio, found ${models.length} models`);
  } catch (err) {
    console.error("[STARTUP] Warning: Could not connect to LMStudio");
  }

  try {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`[START] Ollama-compatible proxy is running`);
      console.log("");
    });
  } catch (err) {
    console.error("[FATAL]", err.message);
    process.exit(1);
  }
}

start();
