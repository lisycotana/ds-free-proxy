/**
 * Credential provider — obtains DS web credentials (cookie, bearer, userAgent)
 * from the DS++ browser extension via MCP, with a file fallback.
 *
 * @module deepseek-free-api/credential-provider
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let cachedCredentials = null
let cacheTime = 0
const CACHE_TTL = 5 * 60 * 1000

/**
 * Try to get credentials from the DS++ extension via MCP.
 * @param {{ endpoint: string, token: string }} mcpConfig
 * @returns {Promise<{cookie:string,bearer:string,userAgent:string}|null>}
 */
async function getFromMcp(mcpConfig) {
  if (!mcpConfig?.endpoint || !mcpConfig?.token) return null
  try {
    // MCP initialize
    const initRes = await fetch(mcpConfig.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${mcpConfig.token}`,
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deepseek-free-api', version: '1' } },
      }),
    })
    const sessionId = initRes.headers.get('mcp-session-id')
    if (!sessionId) return null

    await fetch(mcpConfig.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${mcpConfig.token}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })

    // tools/call — get_ds_credentials
    const callRes = await fetch(mcpConfig.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${mcpConfig.token}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_ds_credentials', arguments: {} },
      }),
    })
    const callBody = await callRes.json()
    if (callBody.error) return null

    // The result content is text; parse JSON from it
    const text = callBody.result?.content?.[0]?.text ?? ''
    const parsed = JSON.parse(text)
    if (parsed.cookie && parsed.bearer) {
      return { cookie: parsed.cookie, bearer: parsed.bearer, userAgent: parsed.userAgent }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Try to get credentials from a local file.
 * @returns {{cookie:string,bearer:string,userAgent:string}|null}
 */
function getFromFile() {
  const credPath = join(homedir(), '.deepseek-free-api', 'credentials.json')
  if (!existsSync(credPath)) return null
  try {
    const data = JSON.parse(readFileSync(credPath, 'utf8'))
    if (data.cookie && data.bearer) {
      return { cookie: data.cookie, bearer: data.bearer, userAgent: data.userAgent }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Get credentials, caching for CACHE_TTL. Falls through MCP → file.
 * @param {{ endpoint?: string, token?: string }} mcpConfig
 * @param {boolean} [forceRefresh] - bypass cache
 * @returns {Promise<{cookie:string,bearer:string,userAgent:string}|null>}
 */
export async function getCredentials(mcpConfig, forceRefresh) {
  if (!forceRefresh && cachedCredentials && Date.now() - cacheTime < CACHE_TTL) {
    return cachedCredentials
  }

  let creds = await getFromMcp(mcpConfig)
  if (!creds) {
    creds = getFromFile()
  }
  if (creds) {
    cachedCredentials = creds
    cacheTime = Date.now()
  }
  return creds
}

/** Invalidate cache so the next call re-fetches. */
export function invalidateCredentials() {
  cachedCredentials = null
  cacheTime = 0
}
