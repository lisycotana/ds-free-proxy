/**
 * Stream converter — transforms DeepSeek web SSE into OpenAI-compatible SSE.
 *
 * DS web SSE events are JSON objects with `p` (path) and `v` (value) fields.
 * Reasoning content comes through paths containing "thinking"/"reasoning".
 * Content text comes through other paths. This converter extracts both and
 * emits OpenAI-format chunks: `{ choices: [{ delta: { content } }] }`.
 *
 * @module deepseek-free-api/stream-converter
 */

import { randomUUID } from 'node:crypto'

const SPECIAL_TOKENS = new Set(['<│end▁of▁thinking│>', '```', '<|im_end|>', '<|im_start|>', 'FINISHED', '\nFINISHED'])
const CITATION_RE = /\[citation:\d+\]/g
const UNICODE_SPECIAL_RE = /[​‌‍﻿]/g

function sanitize(text, isReasoning) {
  if (!text) return null
  const trimmed = text.trim()
  if (SPECIAL_TOKENS.has(trimmed)) return null
  let cleaned = text
  if (!isReasoning) {
    cleaned = cleaned.replace(CITATION_RE, '')
  }
  cleaned = cleaned.replace(UNICODE_SPECIAL_RE, '')
  if (cleaned.length === 0) return null
  return cleaned
}

function isThinkingChunk(data) {
  const p = data.p
  if (typeof p === 'string' && p.length > 0) {
    const pLower = p.toLowerCase()
    if (pLower.includes('thinking') || pLower.includes('reasoning') || pLower.includes('think_content') || pLower.includes('thought')) {
      return true
    }
    return false
  }
  if (data.type === 'thinking' || data.type === 'reasoning') return true
  if (data.type === 'text' || data.type === 'content') return false
  return null
}

function extractContent(data) {
  if (typeof data.v === 'string') return data.v
  if (typeof data.content === 'string') return data.content
  const delta = data.choices?.[0]?.delta
  if (delta?.reasoning_content) return delta.reasoning_content
  if (delta?.content) return delta.content
  return null
}

function makeChunk(completionId, created, model, content, isReasoning) {
  return {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: isReasoning ? { reasoning_content: content } : { content },
      finish_reason: null,
    }],
  }
}

/**
 * Create a transform function that converts a DS SSE stream to OpenAI SSE.
 * @param {string} model - the model name
 * @returns {{ transform: (chunk: Buffer) => string[], end: () => string[] }}
 */
export function createStreamConverter(model) {
  const completionId = `chatcmpl-${randomUUID().slice(0, 8)}`
  const created = Math.floor(Date.now() / 1000)
  let buffer = ''
  let thinkingPhase = model.includes('reasoner')
  let thinkingEnded = false

  function processLine(line) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('event:')) return []

    let dataStr = ''
    if (trimmed.startsWith('data: ')) dataStr = trimmed.slice(6).trim()
    else if (trimmed.startsWith('data:')) dataStr = trimmed.slice(5).trim()
    else return []

    if (dataStr === '') return []
    if (dataStr === '') return []
    if (!dataStr.startsWith('{')) return []

    try {
      const data = JSON.parse(dataStr)
      const fragments = data.v?.response?.fragments
      if (Array.isArray(fragments)) {
        const out = []
        for (const frag of fragments) {
          const isReason = frag.type === 'THINKING' || frag.type === 'reasoning'
          const cleaned = sanitize(frag.content || '', isReason)
          if (cleaned) {
            out.push(`data: ${JSON.stringify(makeChunk(completionId, created, model, cleaned, isReason))}\n\n`)
          }
        }
        return out
      }

      const rawContent = extractContent(data)
      if (rawContent === null || rawContent === undefined) return []

      const isThink = isThinkingChunk(data)
      const effectiveThinking = isThink === true || (thinkingPhase && !thinkingEnded && isThink !== false)

      const endToken = '<│end▁of▁thinking│>'
      if (rawContent.includes(endToken)) {
        thinkingEnded = true
        return []
      }

      const cleaned = sanitize(rawContent, effectiveThinking)
      if (!cleaned) return []

      if (!effectiveThinking && !thinkingEnded && thinkingPhase) {
        thinkingEnded = true
      }

      return [`data: ${JSON.stringify(makeChunk(completionId, created, model, cleaned, effectiveThinking))}\n\n`]
    } catch {
      return []
    }
  }

  return {
    transform(chunk) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      const out = []
      for (const line of lines) {
        out.push(...processLine(line))
      }
      return out
    },
    end() {
      const out = []
      out.push(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`)
      out.push('data:n\n')
      return out
    },
  }
}
