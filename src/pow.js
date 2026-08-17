/**
 * DeepSeek PoW (Proof of Work) solver.
 *
 * DeepSeek's web API requires a proof-of-work challenge to be solved for each
 * completion request. Two algorithms are supported:
 * - `sha256`: hash-based, solved in JS
 * - `DeepSeekHashV1`: WASM-based SHA3, solved via embedded WASM binary
 *
 * The solved answer is base64-encoded as JSON and sent in the
 * `x-ds-pow-response` header.
 *
 * @module ds-free-proxy/pow
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHA3_WASM_B64 = readFileSync(join(__dirname, 'wasm-b64.txt'), 'utf8').trim()

/** @typedef {{ memory: WebAssembly.Memory, __wbindgen_export_0: (n: number, a: number) => number, __wbindgen_add_to_stack_pointer: (n: number) => number, wasm_solve: (r: number, c: number, lc: number, p: number, lp: number, d: number) => void }} DeepSeekWasmExports */

let wasmInstance = null

async function getWasmInstance() {
  if (wasmInstance) return wasmInstance
  const wasmBuffer = Buffer.from(SHA3_WASM_B64, 'base64')
  const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} })
  wasmInstance = instance
  return instance
}

/**
 * Solve a DeepSeekHashV1 challenge using WASM.
 * @param {string} challenge - the challenge string
 * @param {string} salt - the salt
 * @param {number} expireAt - expire timestamp
 * @param {number} difficulty - difficulty target
 * @returns {Promise<number>} the nonce answer
 */
export async function solveDeepSeekHashV1(challenge, salt, expireAt, difficulty) {
  const instance = await getWasmInstance()
  const exports = instance.exports
  const memory = exports.memory
  const alloc = exports.__wbindgen_export_0
  const addToStack = exports.__wbindgen_add_to_stack_pointer
  const wasmSolve = exports.wasm_solve

  const prefix = `${salt}_${expireAt}_`

  const encodeString = (str) => {
    const buf = Buffer.from(str, 'utf8')
    const ptr = alloc(buf.length, 1)
    new Uint8Array(memory.buffer).set(buf, ptr)
    return [ptr, buf.length]
  }

  const [ptrC, lenC] = encodeString(challenge)
  const [ptrP, lenP] = encodeString(prefix)
  const retptr = addToStack(-16)

  wasmSolve(retptr, ptrC, lenC, ptrP, lenP, difficulty)

  const view = new DataView(memory.buffer)
  const status = view.getInt32(retptr, true)
  const answer = view.getFloat64(retptr + 8, true)
  addToStack(16)

  if (status === 0) {
    throw new Error('DeepSeekHashV1 WASM failed to find solution')
  }
  return answer
}

/**
 * Solve a SHA256 PoW challenge.
 * @param {string} challenge - the challenge string
 * @param {string} salt - the salt
 * @param {number} difficulty - difficulty target
 * @returns {number} the nonce answer
 */
export function solvePowSha256(challenge, salt, difficulty) {
  const targetDifficulty = difficulty > 1000 ? Math.floor(Math.log2(difficulty)) : difficulty
  let nonce = 0

  while (nonce < 1_000_000) {
    const input = salt + challenge + nonce
    const hash = createHash('sha256').update(input).digest('hex')

    let zeroBits = 0
    for (const char of hash) {
      const val = parseInt(char, 16)
      if (val === 0) {
        zeroBits += 4
      } else {
        zeroBits += Math.clz32(val) - 28
        break
      }
    }

    if (zeroBits >= targetDifficulty) {
      return nonce
    }
    nonce++
  }
  throw new Error('SHA256 PoW timed out')
}

/**
 * Solve a PoW challenge and return the base64-encoded response for the header.
 * @param {object} challenge - the challenge object from DS API
 * @param {string} targetPath - the API path this PoW is for
 * @returns {Promise<string>} base64-encoded JSON for x-ds-pow-response header
 */
export async function solvePow(challenge, targetPath) {
  let answer
  if (challenge.algorithm === 'sha256') {
    answer = solvePowSha256(challenge.challenge, challenge.salt, challenge.difficulty)
  } else if (challenge.algorithm === 'DeepSeekHashV1') {
    answer = await solveDeepSeekHashV1(
      challenge.challenge,
      challenge.salt,
      challenge.expire_at ?? 0,
      challenge.difficulty,
    )
  } else {
    throw new Error(`Unknown PoW algorithm: ${challenge.algorithm}`)
  }

  return Buffer.from(
    JSON.stringify({ ...challenge, answer, target_path: targetPath }),
  ).toString('base64')
}
