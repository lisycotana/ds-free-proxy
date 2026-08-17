/**
 * DeepSeek web API client — talks to chat.deepseek.com's internal API.
 *
 * Uses cookie + bearer credentials to authenticate. Each completion requires
 * a PoW challenge solved first. Sessions are created fresh per request (no
 * conversation persistence — the caller manages history).
 *
 * @module ds-free-proxy/ds-client
 */

import { solvePow } from './pow.js'

const DS_ORIGIN = 'https://chat.deepseek.com'

/**
 * Create a DS web API client.
 * @param {{ cookie: string, bearer: string, userAgent?: string }} credentials
 * @returns {{ createSession(): Promise<string>, chat(object): Promise<Response>, solvePowForPath(string): Promise<string> }}
 */
export function createDsClient(credentials) {
  const userAgent = credentials.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

  function headers() {
    return {
      Cookie: credentials.cookie,
      'User-Agent': userAgent,
      'Content-Type': 'application/json',
      Accept: '*/*',
      ...(credentials.bearer ? { Authorization: `Bearer ${credentials.bearer}` } : {}),
      Referer: `${DS_ORIGIN}/`,
      Origin: DS_ORIGIN,
      'x-client-platform': 'web',
      'x-client-version': '1.7.0',
      'x-app-version': '20241129.1',
      'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': '28800',
    }
  }

  /** Fetch a PoW challenge from DS and solve it. */
  async function solvePowForPath(targetPath) {
    const challengeRes = await fetch(`${DS_ORIGIN}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ target_path: targetPath }),
    })
    if (!challengeRes.ok) {
      throw new Error(`PoW challenge failed: ${String(challengeRes.status)}`)
    }
    const challengeData = await challengeRes.json()
    const challenge = challengeData.data?.biz_data?.challenge ?? challengeData.data?.challenge
    if (!challenge) {
      throw new Error('PoW challenge response missing challenge field')
    }
    const resolved = typeof challenge === 'object' && challenge.algorithm
      ? challenge
      : challengeData.data?.biz_data ?? challengeData.data
    return solvePow(resolved, targetPath)
  }

  /** Create a new DS chat session. */
  async function createSession() {
    const res = await fetch(`${DS_ORIGIN}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      throw new Error(`Session create failed: ${String(res.status)}`)
    }
    const data = await res.json()
    const sessionId = data.data?.biz_data?.chat_session?.id ?? data.data?.biz_data?.id
    if (!sessionId) {
      throw new Error('Session create returned empty id')
    }
    return sessionId
  }

  /**
   * Send a chat message and return the raw SSE Response.
   * @param {{ sessionId: string, parentMessageId?: number|null, message: string, thinkingEnabled?: boolean, searchEnabled?: boolean }} params
   * @returns {Promise<Response>}
   */
  async function chat(params) {
    const targetPath = '/api/v0/chat/completion'
    const powResponse = await solvePowForPath(targetPath)

    const res = await fetch(`${DS_ORIGIN}${targetPath}`, {
      method: 'POST',
      headers: {
        ...headers(),
        'x-ds-pow-response': powResponse,
      },
      body: JSON.stringify({
        chat_session_id: params.sessionId,
        parent_message_id: params.parentMessageId ?? null,
        prompt: params.message,
        ref_file_ids: [],
        thinking_enabled: params.thinkingEnabled ?? false,
        search_enabled: params.searchEnabled ?? false,
        preempt: false,
      }),
      signal: params.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Chat request failed: ${String(res.status)} ${text}`)
    }
    return res
  }

  return { createSession, chat, solvePowForPath }
}
