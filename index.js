#!/usr/bin/env node
/**
 * deepseek-free-api — OpenAI-compatible DS web API proxy.
 *
 * Credentials are auto-fetched from the DS++ browser extension via MCP.
 * Fallback: ~/.deepseek-free-api/credentials.json
 *
 * Config (environment variables):
 *   DWM_CRED_ENDPOINT  MCP endpoint for credential fetch (default: http://127.0.0.1:3080/mcp)
 *   DWM_CRED_TOKEN     Bearer token for the MCP endpoint
 *   PORT               Listen port (default: 3000)
 *   AUTH_TOKEN         Optional: require this bearer token from clients
 *
 * @module deepseek-free-api/index
 */

import { createApiServer } from './src/server.js'

const port = Number(process.env.PORT ?? 3000)
const mcpConfig = {
  endpoint: process.env.DWM_CRED_ENDPOINT ?? 'http://127.0.0.1:3080/mcp',
  token: process.env.DWM_CRED_TOKEN,
}
const authToken = process.env.AUTH_TOKEN

const { server } = createApiServer({ port, mcpConfig, authToken })

server.listen(port, '127.0.0.1', () => {
  console.error(`deepseek-free-api listening on http://127.0.0.1:${String(port)}`)
  console.error(`  POST /v1/chat/completions`)
  console.error(`  GET  /v1/models`)
  console.error(`  credentials: ${mcpConfig.endpoint ? 'MCP (' + mcpConfig.endpoint + ')' : 'file fallback'}`)
})

const shutdown = (sig) => {
  console.error(`\n${sig}, shutting down...`)
  server.close(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
