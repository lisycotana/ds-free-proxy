# ds-free-proxy

An OpenAI-compatible API proxy that lets you use **DeepSeek web (chat.deepseek.com)** as a model backend — for free, no API key. Works with Cursor, Cline, Continue, Open WebUI, or any client that speaks OpenAI.

Credentials are **auto-pushed from the DS++ browser extension** — no manual cookie scraping, no Playwright, no token files. As long as you're logged into chat.deepseek.com, this proxy has valid credentials.

> **⚠️ Educational/Research Use Only.** This tool reverse-proxies chat.deepseek.com's internal API. DeepSeek may detect automated usage. See [Risk Disclaimer](#risk-disclaimer) below.

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
ds-free-proxy  (this server, localhost:3000)
    │  1. Use cached credentials (pushed by DS++ extension)
    │  2. Create a DS chat session
    │  3. Solve PoW challenge (SHA256 / DeepSeekHashV1 WASM)
    │  4. Submit completion to chat.deepseek.com
    │  5. Convert DS SSE stream → OpenAI SSE stream
    │  (max 2 concurrent requests — DS's per-account limit)
    ▼
chat.deepseek.com  (your free web quota)
```

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

### Step 2: Install ds-free-proxy

```sh
git clone https://github.com/lisycotana/ds-free-proxy.git
cd ds-free-proxy
```

No `npm install` needed — zero dependencies.

### Step 3: Configure dsh MCP server (for the extension)

The DS++ extension connects to a local MCP server (dsh) for tool access and credential relay.

```sh
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add /path/to/dsh-mcp-server
```

Configure `~/.dsh/profiles/web/cordis.patch.yml`:
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
5. Click **Test** or **Refresh tools** — status should show `ready`

### Step 5: Start the proxy

```sh
cd ds-free-proxy
PORT=3000 node index.js
```

Output:
```
ds-free-proxy listening on http://127.0.0.1:3000
  POST /v1/chat/completions   (OpenAI compatible)
  POST /credentials            (DS++ extension push)
  GET  /v1/models
```

### Step 6: Wait for credential push

The DS++ extension pushes credentials automatically (5 seconds after startup, then every 5 minutes).

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

### Step 7: Use it

**Cursor:**
- Settings → Models → Base URL: `http://127.0.0.1:3000/v1`
- API Key: any value (or set `AUTH_TOKEN`)
- Model: `deepseek-v4-flash` or `deepseek-v4-pro`

**curl test:**
```sh
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

### Step 8: (Recommended) Secure the proxy

```sh
export AUTH_TOKEN=my-secret    # require this from API clients
export PUSH_TOKEN=my-push      # require this for credential pushes
PORT=3000 node index.js
```

Without `AUTH_TOKEN`, anyone on your network can call the proxy. Always set it when not running locally.

## File fallback (no DS++ extension)

For headless servers without a browser:

```sh
mkdir -p ~/.ds-free-proxy
cat > ~/.ds-free-proxy/credentials.json << 'EOF'
{
  "cookie": "ds_session_id=xxx; d_id=xxx; ...",
  "bearer": "eyJhbGci...",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}
EOF
```

Get these values: chat.deepseek.com → F12 → Network → find any `/api/v0/` request → copy `Cookie` and `Authorization` headers.

## Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `AUTH_TOKEN` | *(unset)* | Require this bearer token from API clients. **Set this when not running locally.** |
| `PUSH_TOKEN` | *(unset)* | Require this bearer token for credential pushes |
| `MAX_CONCURRENCY` | `2` | Max concurrent DS API calls (hardcoded — DS free web limits ~2 per account) |

## Risk Disclaimer

> **⚠️ READ THIS BEFORE USING.**

1. **Account ban risk**: DeepSeek may detect automated API usage. Reports from similar projects indicate that high concurrency (>2 per account) or rapid repeated requests (like "test connection" buttons in clients) can trigger **temporary account bans (1 day)**. This proxy caps concurrency at 2 to mitigate this, but cannot guarantee safety.

2. **No official support**: This project is not affiliated with or endorsed by DeepSeek. It reverse-proxies chat.deepseek.com's internal API, which may change without notice.

3. **Credential exposure**: Your DS session cookies and bearer token are transmitted over localhost to the proxy. If `AUTH_TOKEN` is not set, anyone on your network can access the proxy and use your credentials. Always set `AUTH_TOKEN` when not running locally.

4. **ToS compliance**: Using this tool may violate DeepSeek's Terms of Service. Use at your own risk.

5. **Rate limits**: DS free web has per-account rate limits. This proxy does not bypass them — it respects the ~2 concurrent limit and queues excess requests.

**This project is for educational and research purposes only. The authors are not responsible for any consequences of using this tool, including account suspension, data loss, or legal issues.**

## Acknowledgements

This project builds on:
- **[freeseek](https://github.com/vinson0522/freeseek)** — the DS web API client, PoW solver (SHA3 WASM), and SSE stream format. The core DS interaction logic is adapted from freeseek's `providers/deepseek/` module.
- **[DeepSeek++](https://github.com/zhu1090093659/deepseek-pp)** — the browser extension that provides credential automation. The DS++ fork exposes `GET_DS_CREDENTIALS` and auto-pushes to this proxy.

Credit for the reverse-engineering of DS web API endpoints, PoW algorithms, and SSE format belongs to the freeseek author.

## Differences from freeseek and similar projects

| | freeseek / Fly143 / NIyueeE | ds-free-proxy |
| --- | --- | --- |
| Credentials | Manual scrape / Playwright / password | Auto from DS++ extension (push) |
| Token expiry | Manual re-scrape / password re-login | Auto-refresh (push every 5min) |
| Linux without desktop | Can't auto-capture | Works (browser is anywhere) |
| Dependencies | Python/Electron/Rust + various deps | Zero (pure Node.js >=20) |
| Concurrency control | Varies | Built-in cap at 2 (DS's limit) |
| API format | OpenAI compatible | OpenAI compatible (same) |

## Limitations

- **No conversation persistence**: each request creates a fresh DS session. Multi-turn conversations are managed by the client.
- **No image input**: DS web doesn't support multimodal in this flow.
- **PoW overhead**: each request solves a PoW challenge (~10-100ms for SHA256, longer for WASM).
- **Max 2 concurrent**: hardcoded to respect DS free web's per-account limit.

## License

MIT. The freeseek and DeepSeek++ projects are the property of their respective authors.
