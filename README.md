# deepseek-free-api

An OpenAI-compatible API proxy that lets you use **DeepSeek web (chat.deepseek.com)** as a model backend — for free, no API key. Works with Cursor, Cline, Continue, Open WebUI, or any client that speaks OpenAI.

Credentials are **auto-fetched from the DS++ browser extension** — no manual cookie scraping, no Playwright browser launch, no token expiry headaches. As long as you're logged into chat.deepseek.com, this proxy has valid credentials.

## How it works

```
Cursor / Cline / any OpenAI client
    │  POST /v1/chat/completions  (standard OpenAI format)
    ▼
deepseek-free-api  (this server, localhost:3000)
    │  1. Get credentials from DS++ extension (cookie + bearer via MCP)
    │  2. Create a DS chat session
    │  3. Solve PoW challenge (SHA256 / DeepSeekHashV1 WASM)
    │  4. Submit completion to chat.deepseek.com
    │  5. Convert DS SSE stream → OpenAI SSE stream
    ▼
chat.deepseek.com  (your free web quota)
```

## Quick start

```sh
git clone https://github.com/lisycotana/deepseek-free-api.git
cd deepseek-free-api
PORT=3000 node index.js
```

Then in your client (e.g. Cursor):

```
Base URL: http://127.0.0.1:3000/v1
API Key: (anything — auth is optional)
Model: deepseek-chat
```

### Models

| Model ID | What it does |
| --- | --- |
| `deepseek-chat` | Standard chat (V3/V4) |
| `deepseek-reasoner` | Deep thinking / reasoning chain |
| `deepseek-chat-search` | Standard chat + web search |
| `deepseek-reasoner-search` | Deep thinking + web search |

## Configuration

All config via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DWM_CRED_ENDPOINT` | `http://127.0.0.1:3080/mcp` | MCP endpoint to fetch DS credentials from (the DS++ extension's MCP server) |
| `DWM_CRED_TOKEN` | *(unset)* | Bearer token for the MCP endpoint |
| `PORT` | `3000` | Listen port |
| `AUTH_TOKEN` | *(unset)* | Optional: require this bearer token from clients |

### Credential sources (in priority order)

1. **DS++ extension via MCP** (recommended): the extension holds your DS login state. The proxy calls `get_ds_credentials` over MCP to get cookie + bearer. No manual config.
2. **File fallback**: `~/.deepseek-free-api/credentials.json`:
   ```json
   {
     "cookie": "ds_session_id=xxx; d_id=xxx; ...",
     "bearer": "eyJhbGci...",
     "userAgent": "Mozilla/5.0 ..."
   }
   ```

Credentials are cached for 5 minutes and auto-refreshed on 401.

## Acknowledgements

This project builds on:
- **[freeseek](https://github.com/vinson0522/freeseek)** — the DS web API client, PoW solver (SHA3 WASM), and SSE stream format. The core DS interaction logic is adapted from freeseek's `providers/deepseek/` module.
- **[DeepSeek++](https://github.com/zhu1090093659/deepseek-pp)** — the browser extension that provides credential automation. The DS++ fork exposes `get_ds_credentials` so this proxy never needs manual cookie scraping.

Credit for the reverse-engineering of DS web API endpoints, PoW algorithms, and SSE format belongs to the freeseek author. This project simplifies the credential management layer.

## Differences from freeseek

| | freeseek | deepseek-free-api |
| --- | --- | --- |
| Credentials | Manual scrape / Playwright capture | Auto from DS++ extension via MCP |
| Token expiry | Manual re-scrape | Auto-refresh on 401 |
| Linux without desktop | Can't auto-capture | Works (browser is anywhere) |
| Dependencies | Electron, playwright-core | Zero (pure Node.js >=20) |
| PoW | Built-in | Built-in (adapted from freeseek) |
| API format | OpenAI compatible | OpenAI compatible (same) |

## Limitations

- **No conversation persistence**: each `/v1/chat/completions` request creates a fresh DS session. Multi-turn conversations are managed by the client (it sends full history each time).
- **No image input**: DS web doesn't support multimodal in this flow.
- **PoW overhead**: each request solves a PoW challenge (~10-100ms for SHA256, longer for WASM).
- **Rate limits**: subject to DS web's rate limiting. Concurrent requests should be reasonable.

## License

MIT. The freeseek and DeepSeek++ projects are the property of their respective authors.
