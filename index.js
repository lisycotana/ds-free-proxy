#!/usr/bin/env node
/**
 * deepseek-free-api — OpenAI-compatible DS web API proxy.
 *
 * Credentials are pushed by the DS++ browser extension to POST /credentials.
 * Fallback: ~/.deepseek-free-api/credentials.json
 *
 * Config (environment variables):
 *   PORT               Listen port (default: 3000)
 *   AUTH_TOKEN         Optional: require this bearer token from API clients
 *   PUSH_TOKEN         Optional: require this bearer token for credential pushes
 *
 * @module deepseek-free-api/index
 */

import { createApiServer } from './src/server.js'

const port = Number(process.env.PORT ?? 3000)
const authToken = process.env.AUTH_TOKEN
const pushToken = process.env.PUSH_TOKEN

const { server } = createApiServer({ port, authToken, pushToken })

server.listen(port, '127.0.0.1', () => {
  console.error(`deepseek-free-api listening on http://127.0.0.1:${String(port)}`)
  console.error(`  POST /v1/chat/completions   (OpenAI compatible)`)
  console.error(`  POST /credentials            (DS++ extension push)`)
  console.error(`  GET  /v1/models`)
  console.error(`  client auth:  ${authToken ? 'enabled' : 'disabled'}`)
  console.error(`  push auth:    ${pushToken ? 'enabled' : 'disabled'}`)
})

const shutdown = (sig) => {
  console.error(`\n${sig}, shutting down...`)
  server.close(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
