/**
 * OpenAI-compatible API server.
 *
 * Provides /v1/chat/completions and /v1/models endpoints. Each chat request
 * is converted to a DS web API call: create session → solve PoW → submit
 * completion → stream SSE back as OpenAI-format chunks.
 *
 * Credentials arrive via POST /credentials (pushed by the DS++ extension) or
 * from a file fallback (~/.ds-free-proxy/credentials.json).
 *
 * Concurrency is capped at 2 (DS web's per-account limit). Excess requests
 * queue rather than fire concurrently — this prevents ban-triggering bursts.
 *
 * @module ds-free-proxy/server
 */

import { createServer } from 'node:http'
import { createDsClient } from './ds-client.js'
import { getCredentials, pushCredentials, invalidateCredentials } from './credential-provider.js'
import { createStreamConverter } from './stream-converter.js'

/** Max concurrent DS API calls. DS free web limits ~2 per account. */
const MAX_CONCURRENCY = 2
let activeRequests = 0
const queue = []

/**
 * Acquire a concurrency slot. Returns a promise that resolves when a slot is
 * free. Must be paired with releaseRequest().
 * @returns {Promise<void>}
 */
function acquireRequest() {
  if (activeRequests < MAX_CONCURRENCY) {
    activeRequests++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    queue.push(() => { activeRequests++; resolve() })
  })
}

/** Release a concurrency slot and wake the next queued request. */
function releaseRequest() {
  activeRequests--
  const next = queue.shift()
  if (next) next()
}

/** @param {any} body */
function buildPrompt(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  const parts = []
  if (system) parts.push(`[System]\n${system}`)
  for (const msg of rest) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User'
    parts.push(`[${role}]\n${msg.content}`)
  }
  parts.push('[Assistant]')
  return parts.join('\n\n')
}

/**
 * Create the HTTP server.
 * @param {{ port: number, authToken?: string, pushToken?: string }} options
 * @returns {{ server: import('node:http').Server, stop: () => Promise<void> }}
 */
export function createApiServer(options) {
  async function handleChat(req, res) {
    let body
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }))
      return
    }

    const model = body.model || 'deepseek-v4-flash'
    const searchEnabled = model.endsWith('-search')
    const baseModel = searchEnabled ? model.replace(/-search$/, '') : model
    const thinkingEnabled = baseModel.includes('pro') || baseModel.includes('reasoner')

    let credentials = getCredentials()
    if (!credentials) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'No DS credentials. Waiting for DS++ extension to push credentials, or configure ~/.ds-free-proxy/credentials.json' } }))
      return
    }

    // Concurrency control: DS free web limits ~2 concurrent per account.
    // Excess requests queue rather than fire concurrently — this prevents
    // ban-triggering bursts.
    await acquireRequest()
    try {
    const client = createDsClient(credentials)
    let sessionId
    try {
      sessionId = await client.createSession()
    } catch (e) {
      // Credentials might be stale — invalidate and retry from file once.
      invalidateCredentials()
      credentials = getCredentials()
      if (!credentials) throw e
      const retryClient = createDsClient(credentials)
      sessionId = await retryClient.createSession()
    }

    const prompt = buildPrompt(body.messages || [])
    const dsRes = await client.chat({
      sessionId,
      parentMessageId: null,
      message: prompt,
      thinkingEnabled,
      searchEnabled,
    })

    const stream = body.stream !== false
    const converter = createStreamConverter(baseModel)

    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const reader = dsRes.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunks = converter.transform(Buffer.from(value))
          for (const c of chunks) res.write(c)
        }
        for (const c of converter.end()) res.write(c)
      } catch {
        // stream error — best effort close
      }
      res.end()
    } else {
      // Non-streaming: collect full response
      const reader = dsRes.body.getReader()
      let fullContent = ''
      let fullReasoning = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunks = converter.transform(Buffer.from(value))
        for (const c of chunks) {
          try {
            const parsed = JSON.parse(c.replace('data: ', '').trim())
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) fullContent += delta.content
            if (delta?.reasoning_content) fullReasoning += delta.reasoning_content
          } catch { /* skip */ }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: baseModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: fullContent, reasoning_content: fullReasoning || undefined },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }))
    }
    } finally {
      releaseRequest()
    }
  }

  async function handleCredentialsPush(req, res) {
    let body
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }
    if (!body.cookie || !body.bearer) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing cookie or bearer' }))
      return
    }
    pushCredentials(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  function handleModels(req, res) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek-web' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek-web' },
        { id: 'deepseek-v4-flash-search', object: 'model', owned_by: 'deepseek-web' },
        { id: 'deepseek-v4-pro-search', object: 'model', owned_by: 'deepseek-web' },
        // Legacy aliases for client compatibility
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek-web' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek-web' },
        { id: 'deepseek-chat-search', object: 'model', owned_by: 'deepseek-web' },
        { id: 'deepseek-reasoner-search', object: 'model', owned_by: 'deepseek-web' },
      ],
    }))
  }

  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, 'http://localhost')

    // Credential push endpoint — uses pushToken if configured
    if (req.method === 'POST' && url.pathname === '/credentials') {
      if (options.pushToken) {
        const auth = req.headers.authorization
        if (auth !== `Bearer ${options.pushToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
          return
        }
      }
      handleCredentialsPush(req, res)
      return
    }

    // Client auth (optional)
    if (options.authToken) {
      const auth = req.headers.authorization
      if (auth !== `Bearer ${options.authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      try {
        await handleChat(req, res)
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }))
        }
      }
    } else if (req.method === 'GET' && url.pathname === '/v1/models') {
      handleModels(req, res)
    } else {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found' } }))
    }
  })

  return {
    server,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
