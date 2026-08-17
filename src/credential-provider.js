/**
 * Credential provider — obtains DS web credentials (cookie, bearer, userAgent).
 *
 * Two sources, in priority order:
 * 1. Push from the DS++ extension (POST /credentials): the extension actively
 *    pushes credentials every few minutes and on login state change. This is
 *    the primary path — zero manual config, auto-refreshing.
 * 2. File fallback (~/.ds-free-proxy/credentials.json): for headless or
 *    manual setups where the extension push is not available.
 *
 * @module ds-free-proxy/credential-provider
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let cachedCredentials = null
let cacheTime = 0
const CACHE_TTL = 10 * 60 * 1000

/**
 * Receive pushed credentials from the DS++ extension.
 * Called by the POST /credentials handler. Bypasses cache TTL — a push is
 * always fresh by definition.
 * @param {{ cookie: string, bearer: string, userAgent: string }} creds
 */
export function pushCredentials(creds) {
  if (creds && creds.cookie && creds.bearer) {
    cachedCredentials = { cookie: creds.cookie, bearer: creds.bearer, userAgent: creds.userAgent || '' }
    cacheTime = Date.now()
  }
}

/**
 * Try to get credentials from a local file.
 * @returns {{cookie:string,bearer:string,userAgent:string}|null}
 */
function getFromFile() {
  const credPath = join(homedir(), '.ds-free-proxy', 'credentials.json')
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
 * Get credentials. Uses the pushed cache first; falls back to file.
 * @returns {{cookie:string,bearer:string,userAgent:string}|null}
 */
export function getCredentials() {
  if (cachedCredentials) {
    return cachedCredentials
  }
  return getFromFile()
}

/** Invalidate cache so the next call falls back to file. */
export function invalidateCredentials() {
  cachedCredentials = null
  cacheTime = 0
}
