# deepseek-free-api

An OpenAI-compatible API proxy that lets you use **DeepSeek web (chat.deepseek.com)** as a model backend — for free, no API key. Works with Cursor, Cline, Continue, Open WebUI, or any client that speaks OpenAI.

Credentials are **auto-pushed from the DS++ browser extension** — no manual cookie scraping, no Playwright, no token files. As long as you're logged into chat.deepseek.com, this proxy has valid credentials.

## Models

| Model ID | DS web mode | Actual model |
| --- | --- | --- |
| `deepseek-v4-flash` | Instant Mode | V4-Flash (284B/13B) |
| `deepseek-v4-pro` | Expert Mode | V4-Pro (1.6T/49B, 1M context) |
| `deepseek-v4-flash-search` | Instant + web search | V4-Flash + search |
| `deepseek-v4-pro-search` | Expert + web search | V4-Pro + search |
| `deepseek-chat` | *(legacy alias → v4-flash)* | V4-Flash |
| `deepseek-reasoner` | *(legacy alias → v4-pro)* | V4-Pro |

DS web is fully free — no membership, no API key. Both V4-Flash and V4-Pro are available on chat.deepseek.com at no cost.

## How it works

```
Cursor / Cline / any OpenAI client
    │  POST /v1/chat/completions  (standard OpenAI format)
    ▼
deepseek-free-api  (this server, localhost:3000)
    │  1. Use cached credentials (pushed by DS++ extension)
    │  2. Create a DS chat session
    │  3. Solve PoW challenge (SHA256 / DeepSeekHashV1 WASM)
    │  4. Submit completion to chat.deepseek.com
    │  5. Convert DS SSE stream → OpenAI SSE stream
    ▼
chat.deepseek.com  (your free web quota)
```

Credentials are pushed by the DS++ browser extension to `POST /credentials` every 5 minutes. The proxy caches them and auto-refreshes on 401.

## Full deployment guide

### Prerequisites

- **Node.js >= 20**
- **Chrome or Edge browser**
- A **DeepSeek account** (free — sign up at chat.deepseek.com)

### Step 1: Install the DS++ browser extension (fork)

The fork adds `cookies` permission and a credential pusher that auto-sends your DS login state to the proxy.

```sh
git clone https://github.com/lisycotana/deepseek-pp-delegate.git
cd deepseek-pp-delegate
npm install
npm run build:chrome
```

Load in browser:
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select `deepseek-pp-delegate/dist/chrome-mv3`
4. If you have the store version of DeepSeek++, **disable it** (two copies conflict)
5. Note the **extension ID** (a string of letters on the extension card)

### Step 2: Install deepseek-free-api

```sh
git clone https://github.com/lisycotana/deepseek-free-api.git
cd deepseek-free-api
```

No `npm install` needed — zero dependencies.

### Step 3: Configure dsh MCP server (for the extension)

The DS++ extension needs to connect to a local MCP server (dsh) to push credentials. Install dsh and the MCP server plugin:

```sh
# Install dsh
npm install -g @deepseek-ai/dsh

# Add the MCP server plugin to your web profile
dsh plugin --profile web add /path/to/dsh-mcp-server
```

Configure the MCP server in `~/.dsh/profiles/web/cordis.patch.yml`:
```yaml
- id: mcp-server
  config:
    token: <generate with: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))">
    allowedOrigins:
      - chrome-extension://<your-extension-id-from-step-1>
    agentPreset: web-delegate
```

Start dsh:
```sh
dsh web
```

### Step 4: Configure MCP in DS++ sidebar

1. Open `chat.deepseek.com` and **sign in**
2. Open the DS++ sidebar (click the extension icon)
3. Go to **Capabilities → MCP**
4. Add a new MCP server:
   - Transport: `streamable_http`
   - URL: `http://127.0.0.1:3080/mcp`
   - Secret: `bearer`, value = the token from Step 3
   - Request timeout: ≥ 60000 ms
5. Click **Test** or **Refresh tools** — status should show `ready` with 29+ tools

### Step 5: Start the API proxy

```sh
cd deepseek-free-api
PORT=3000 node index.js
```

You should see:
```
deepseek-free-api listening on http://127.0.0.1:3000
  POST /v1/chat/completions   (OpenAI compatible)
  POST /credentials            (DS++ extension push)
  GET  /v1/models
```

### Step 6: Wait for credential push

The DS++ extension pushes credentials to the proxy automatically:
- On extension startup (5 seconds after SW wake)
- Every 5 minutes after that

To push immediately, run this in the DS++ sidebar DevTools console (right-click sidebar → Inspect → Console):
```javascript
chrome.runtime.sendMessage({type: 'GET_DS_CREDENTIALS'}, (r) => {
  if (r.ok) {
    fetch('http://127.0.0.1:3000/credentials', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(r)
    }).then(() => console.log('pushed!'))
  } else {
    console.log('no creds:', r.error)
  }
})
```

If you see `pushed!`, credentials are ready.

### Step 7: Use it in your client

**Cursor:**
- Settings → Models → OpenAI API Key → set Base URL to `http://127.0.0.1:3000/v1`
- API Key: any value (auth is disabled by default)
- Model: `deepseek-v4-flash` or `deepseek-v4-pro`

**Cline / Continue / Open WebUI:**
- Base URL: `http://127.0.0.1:3000/v1`
- Model: `deepseek-v4-pro` (for reasoning) or `deepseek-v4-flash` (for speed)

**curl test:**
```sh
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

### Step 8: (Optional) Secure the proxy

Set environment variables before starting:
```sh
export AUTH_TOKEN=my-secret-key    # require this from API clients
export PUSH_TOKEN=my-push-key      # require this for credential pushes
PORT=3000 node index.js
```

## File fallback (no DS++ extension)

If you can't run the DS++ extension (e.g. headless server), use a credentials file:

```sh
mkdir -p ~/.deepseek-free-api
cat > ~/.deepseek-free-api/credentials.json << 'EOF'
{
  "cookie": "ds_session_id=xxx; d_id=xxx; ...",
  "bearer": "eyJhbGci...",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}
EOF
```

To get these values: open chat.deepseek.com → F12 → Network → find any `/api/v0/` request → copy the `Cookie` and `Authorization` headers.

## Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `AUTH_TOKEN` | *(unset)* | Optional: require this bearer token from API clients |
| `PUSH_TOKEN` | *(unset)* | Optional: require this bearer token for credential pushes |

## Troubleshooting

**"No DS credentials"** — The extension hasn't pushed credentials yet. Wait 5 seconds after extension startup, or run the manual push command (Step 6).

**"Session create returned empty id"** — Credentials are stale. The extension will re-push within 5 minutes, or run the manual push command.

**403 from MCP** — The extension ID in dsh's `allowedOrigins` doesn't match. Check the extension ID in `chrome://extensions` and update `cordis.patch.yml`.

**MCP "tools fetch failed"** — dsh is not running or the MCP token doesn't match. Verify `dsh web` is running and the token in the sidebar matches `cordis.patch.yml`.

**PoW timeout** — Rare. DS may be rate-limiting. Wait a minute and retry.

## Acknowledgements

This project builds on:
- **[freeseek](https://github.com/vinson0522/freeseek)** — the DS web API client, PoW solver (SHA3 WASM), and SSE stream format. The core DS interaction logic is adapted from freeseek's `providers/deepseek/` module.
- **[DeepSeek++](https://github.com/zhu1090093659/deepseek-pp)** — the browser extension that provides credential automation. The DS++ fork exposes `GET_DS_CREDENTIALS` and auto-pushes to this proxy.

Credit for the reverse-engineering of DS web API endpoints, PoW algorithms, and SSE format belongs to the freeseek author.

## Differences from freeseek

| | freeseek | deepseek-free-api |
| --- | --- | --- |
| Credentials | Manual scrape / Playwright capture | Auto from DS++ extension (push) |
| Token expiry | Manual re-scrape | Auto-refresh (push every 5min) |
| Linux without desktop | Can't auto-capture | Works (browser is anywhere) |
| Dependencies | Electron, playwright-core | Zero (pure Node.js >=20) |
| PoW | Built-in | Built-in (adapted from freeseek) |
| API format | OpenAI compatible | OpenAI compatible (same) |

## Limitations

- **No conversation persistence**: each request creates a fresh DS session. Multi-turn conversations are managed by the client (it sends full history each time).
- **No image input**: DS web doesn't support multimodal in this flow.
- **PoW overhead**: each request solves a PoW challenge (~10-100ms for SHA256, longer for WASM).
- **Rate limits**: subject to DS web's rate limiting. Concurrent requests should be reasonable.

## License

MIT. The freeseek and DeepSeek++ projects are the property of their respective authors.
