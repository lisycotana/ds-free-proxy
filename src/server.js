/**
 * OpenAI-compatible API server.
 *
 * Provides /v1/chat/completions and /v1/models endpoints. Each chat request
 * is converted to a DS web API call: create session → solve PoW → submit
 * completion → stream SSE back as OpenAI-format chunks.
 *
 * @module deepseek-free-api/server
 */

import { createServer } from 'node:http'
import { createDsClient } from './ds-client.js'
import { getCredentials, invalidateCredentials } from './credential-provider.js'
import { createStreamConverter } from './stream-converter.js'

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
 * @param {{ port: number, mcpConfig: {endpoint?:string,token?:string}, authToken?: string }} options
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

    const model = body.model || 'deepseek-chat'
    const searchEnabled = model.endsWith('-search')
    const baseModel = searchEnabled ? model.replace(/-search$/, '') : model
    const thinkingEnabled = baseModel.includes('reasoner')

    let credentials = await getCredentials(options.mcpConfig)
    if (!credentials) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'No DS credentials available. Ensure DS++ extension is running or configure ~/.deepseek-free-api/credentials.json' } }))
      return
    }

    const client = createDsClient(credentials)
    let sessionId
    try {
      sessionId = await client.createSession()
    } catch (e) {
      // Credentials might be stale — refresh once
      invalidateCredentials()
      credentials = await getCredentials(options.mcpConfig, true)
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
      } catch (e) {
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
  }

  function handleModels(req, res) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
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

    // Auth (optional)
    if (options.authToken) {
      const auth = req.headers.authorization
      if (auth !== `Bearer ${options.authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
        return
      }
    }

    const url = new URL(req.url, 'http://localhost')
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
