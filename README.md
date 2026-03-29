# VS Code Proxy - LMStudio Ollama Adapter

A Node.js Express proxy that translates VS Code Copilot's Ollama API requests into LMStudio API calls, allowing Code Copilot to use LMStudio models.

# Running
Run with
  node vscode_lms_proxy.mjs
or
  node vscode_lms_proxy.mjs --help
or
  update the shebang at the top of the script (#!/usr/bin/env node), chmod +x, and run directly

It is more convenient to run this script on the same machine (localhost) that is running LM Studio.  If LMS is on another machine, set the LMS address with 
LMSTUDIO_URL="http://your-host:1234" node vscode_lms_proxy.mjs
or
export LMSTUDIO_URL="http://your-host:1234"
node vscode_lms_proxy.mjs

# Code Setup
- In vscode Copilot chat window, click model name at the bottom then Manage Language Models (Gear Icon).  
- Click the Add Models button and choose Ollama.
- In the popup window at the top, fill in the server name or leave as Ollama.  It's not important
- In the host address window, enter the address of the PC the script is running on, or leave it as localhost if you're on the same machine.
- Code will show your list of models and their context limits.  Crank up the context limits in LMS if needed, then restart Code to rescan.
-  To enable a model for use, click the eyeball next to model name to highlight it in white and enable usage
- Models need TOOL ability to act as agent
- NOTE: If you change models, you likely need to restart vscode to get it to reread the list and capabilities.  You generally do NOT have to restart the proxy, but it's worth a shot if your fresh new model is not showing in the list.



## Project Overview

### Purpose
Adapt LMStudio's native API to be Ollama-compatible, allowing VS Code Copilot Chat to discover, validate, and communicate with models running in LMStudio without modification to the client or backend.


## Architecture

### Request Flow

```
VS Code Copilot Chat
         ↓
   localhost:11434 (Ollama API)
         ↓
  vscode_proxy.mjs (Express)
         ↓
  LMStudio API (localhost:1234)
         ↓
  LMStudio Backend
         ↓
   Running Model
```

### Core Components

**vscode_proxy.mjs** - Main proxy application
- Node.js Express server listening on port 11434
- Maps Ollama API endpoints to LMStudio equivalents
- Caches model metadata with 5-minute TTL
- Supports streaming and JSON response modes
- Synthesizes Ollama-compatible responses from LMStudio data

## API Endpoints

### GET /api/tags
**Purpose:** List all available models

**Client Usage:** VS Code calls this to discover available models

**Response Format:**
```json
{
  "models": [
    {
      "name": "Qwen2.5 7B Instruct",
      "model": "Qwen2.5 7B Instruct",
      "modified_at": "2026-03-28T...",
      "size": 4683073632,
      "digest": "2a1aaaf30e79bc98...",
      "details": {
        "parent_model": "",
        "format": "gguf",
        "family": "qwen2",
        "families": ["qwen2"],
        "parameter_size": "7.6B",
        "quantization_level": "Q4_K_M"
      }
    }
  ]
}
```

**Implementation Notes:**
- Fetches from LMStudio's `/api/v1/models` endpoint
- Returns LMStudio display_name as model identifier
- Results cached for 5 minutes
- All LMStudio models returned without filtering

### POST /api/show
**Purpose:** Get detailed model information including capabilities and context length

**Client Usage:** VS Code calls this to validate model capabilities before enabling features

**Request:**
```json
{
  "model": "Qwen2.5 7B Instruct"
}
```

**Response (Default Synthetic Mode):**
```json
{
  "capabilities": ["completion", "tools", "thinking"],
  "model_info": {
    "general.architecture": "qwen2",
    "qwen2.context_length": 131072
  }
}
```

**Implementation Flow:**
1. Parse request model name
2. Find matching model in cached LMStudio models list
3. Query `/api/v0/models/{model_key}` for real metadata:
   - `arch` → `general.architecture`
   - `max_context_length` → `{arch}.context_length`
   - `capabilities` includes "tool_use" if model supports it
4. Detect dynamic capabilities from LMStudio (`trained_for_tool_use` flag)
5. Return Ollama-compatible response

**Real Context Lengths (Examples):**
- Qwen2.5 7B Instruct: 131,072 tokens
- Nemotron Nano 9B: 1,048,576 tokens
- Qwen2.5 Coder 14B: 32,768 tokens

### POST /v1/chat/completions
**Purpose:** Generate chat completions with optional tool calls

**Client Usage:** VS Code sends chat messages, tool definitions, and request parameters

**Request Example:**
```json
{
  "model": "Qwen2.5 7B Instruct",
  "messages": [
    {"role": "user", "content": "Help me write a function"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "write_file",
        "description": "Write content to a file",
        "parameters": {...}
      }
    }
  ],
  "temperature": 0.7,
  "top_p": 0.95,
  "stream": false
}
```

**Implementation Flow:**
1. Extract model name from request
2. Find model in LMStudio models list
3. Map display_name → LMStudio model key
4. Preserve ALL request fields using spread operator: `{ ...req.body, model: lmModelKey }`
5. Set stream mode based on client preference (not forced to true)
6. Forward to LMStudio `/v1/chat/completions`
7. Handle response:
   - If `stream: true` → Forward SSE stream directly
   - If `stream: false` → Parse JSON and return single response

**Critical Detail:** All request fields must be forwarded (tools, temperature, top_p, n, stream_options) for tool calls to work.

## Internal Functions

### fetchLMStudioModels()
```javascript
async function fetchLMStudioModels() {
  // Returns: Array of model objects from LMStudio
  // Cache: 5-minute TTL
  // Endpoint: ${LMSTUDIO_URL}/api/v1/models
  
  // Typical object structure:
  {
    "display_name": "Qwen2.5 7B Instruct",
    "key": "qwen2.5-7b-instruct",
    "id": "./models/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    "object": "model",
    "owned_by": "lmstudio-community",
    "permissions": [],
    "parameters": "7.61B",
    "context_length": 32768,
    "architecture": "qwen2",
    "quantization": { "name": "Q4_K_M", ... },
    "format": "gguf",
    "size_bytes": 4683073632,
    "vram_size_bytes": 5726822400,
    "loaded": false,
    "architecture_kind": "transformer",
    "publisher": "Qwen",
    "architecure": "qwen2",
    "capabilities": {
      "trained_for_tool_use": true
    },
    "metadata": {}
  }
}
```

### generateDigest(modelKey)
```javascript
function generateDigest(modelKey) {
  // Returns: SHA256 hash of model key (hex encoded)
  // Used in /api/tags response for consistency with Ollama format
  
  return crypto.createHash("sha256").update(modelKey).digest("hex");
}
```

### getLocalIP()
```javascript
function getLocalIP() {
  // Returns: Local network IPv4 address (first non-loopback)
  // Used in startup output for user convenience
  
  // Scans os.networkInterfaces() for IPv4 family, non-internal interfaces
}
```

## Configuration

### Command-Line Flags

**--verbose**
- Enables detailed console logging
- Logs model lookups, handler execution, capability detection
- Useful for debugging

**--log**
- Enables traffic logging to file
- Logs to `traffic.log` (default filename)
- Logs all requests/responses with timing

**--help**
- Displays usage information

### Environment Variables

**PORT** (default: 11434)
- Server listen port

**LMSTUDIO_URL** (default: http://localhost:1234)
- LMStudio backend URL

**LOG_FILE** (default: ./traffic.log)
- Path for traffic logs when --log is enabled

**TIMEOUT_MS** (default: 300000 = 5 minutes)
- Request timeout for upstream calls

## Request Field Forwarding

The key innovation that fixed tool calls:

```javascript
// BEFORE (broken):
const lmRequest = { model, messages, stream: true };
// This dropped: tools, temperature, top_p, n, stream_options

// AFTER (working):
const lmRequest = { ...req.body, model: lmModelKey, stream: shouldStream };
// This preserves ALL fields from client request
```

LMStudio needs every field from the original request to:
- Understand tool definitions
- Apply sampling parameters
- Handle streaming preference
- Process stop sequences

## Response Modes

### Streaming (stream: true)
- Client signal: `"stream": true` in request
- LMStudio returns Server-Sent Events (SSE)
- Proxy forwards SSE stream directly to client
- Minimal latency, allows real-time token display

### Non-Streaming (stream: false or omitted)
- Client signal: `"stream": false` or not specified
- LMStudio returns complete response JSON
- Proxy parses and returns single JSON response
- Client receives full response at once

## Model Metadata Discovery

### Discovery Process
1. Client requests `/api/show?model=Qwen2.5 7B Instruct`
2. Proxy finds model in cached list by display_name
3. Extracts model key: `qwen2.5-7b-instruct`
4. Fetches details from `LMStudio/api/v0/models/{key}`
5. Extracts real metadata:
   - `arch` (e.g., "qwen2", "nemotron_h")
   - `max_context_length` (e.g., 131072, 1048576)
   - `capabilities` array
6. Builds Ollama-compatible response
7. Falls back to 131k if detail fetch fails

### Why This Works
- LMStudio exposes clean metadata at `/api/v0/models/{key}`
- Architecture field maps directly to Ollama format
- VS Code parses `{arch}.context_length` pattern
- All 22 models return real, accurate context lengths

## Capability Detection

**Dynamic Capability Detection:**
```javascript
const capabilities = ["completion"]; // All models support

// Check LMStudio model metadata
if (lmModel.capabilities?.trained_for_tool_use) {
  capabilities.push("tools");
  capabilities.push("thinking");
}
```

**Result:**
- Models with `trained_for_tool_use: true` → report tools, thinking
- Other models → report only completion
- VS Code respects this and enables/disables features accordingly

## Performance Characteristics

- **Model List Fetch:** Cached, 5-minute TTL
- **Model Details Fetch:** Per `/api/show` call, ~50-100ms
- **/api/tags Response:** Instant (cached)
- **Streaming Completions:** Minimal overhead, SSE passthrough
- **Non-Streaming Completions:** Entire LMStudio response time + parsing

## File Structure

```
vscode_proxy/
├── vscode_proxy.mjs              # Main proxy (active)
├── README.md                      # This file
├── plans/
│   ├── 1_bringup.md              # Initial bringing up
│   ├── 2_proxy_implementation.md  # Proxy design
│   ├── 3_response_testing.md      # Testing methodology
│   └── 4_show_capabilities.md     # Capabilities & context detection
├── research/
│   ├── LMS_API.md
│   ├── OLLAMA_LMSTUDIO_API_MAPPING.md
│   ├── TRAFFIC_COMPARISON.md
│   └── [other research notes]
├── debugscripts/
│   └── [test scripts]
├── logs/
│   └── [traffic logs]
└── OLD/
    ├── vscode_proxy_v3.mjs
    ├── model_map.txt
    ├── model_map_all.txt
    └── [deprecated versions]
```

## Development Notes

### Why No External File Dependencies
- All model data comes from LMStudio's `/api/v1/models` endpoint
- All context/architecture data from `/api/v0/models/{key}` endpoint
- Minimal config needed - environment variables handle everything
- No external model maps or field definitions required

### Key Learnings
1. **Request Field Forwarding:** Must preserve ALL fields, not reconstruct
2. **Context Length Source:** LMStudio's `/api/v0/models/{key}` has real values
3. **Architecture Detection:** Field immediately available, no calculation needed
4. **Streaming Preference:** Respect client's stream flag, don't force true
5. **Model Naming:** Use LMStudio display_name directly, no mapping layer needed

## Testing

### Quick Manual Test
```bash
# Start proxy
node vscode_proxy.mjs --verbose

# Test /api/tags
curl http://localhost:11434/api/tags | python3 -m json.tool

# Test /api/show for specific model
curl -X POST http://localhost:11434/api/show \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen2.5 7B Instruct"}' | python3 -m json.tool

# Test chat completion with tools
curl -X POST http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen2.5 7B Instruct",
    "messages": [{"role": "user", "content": "Hello"}],
    "tools": [...],
    "stream": false
  }' | python3 -m json.tool
```

## Troubleshooting

### Models not appearing in VS Code
1. Check `/api/tags` returns models
2. Verify LMStudio is accessible at configured URL
3. Check --verbose output for model lookup logs

### Tool calls not working
1. Verify model has `trained_for_tool_use: true` in LMStudio metadata
2. Check `/api/show` returns "tools" in capabilities
3. Verify request includes complete `tools` array
4. Check temperature, top_p, other sampling params are preserved

### Context length incorrect
1. Check `/api/show` response includes model_info with context_length
2. Verify `/api/v0/models/{key}` returns max_context_length from LMStudio
3. Check LMStudio model is actually loaded with correct context window

### Responses streaming when they shouldn't
1. Check `stream` field in request (client may be sending true)
2. Verify proxy sets shouldStream correctly: `req.body.stream === true`
3. Check response handler for streaming vs JSON mode
