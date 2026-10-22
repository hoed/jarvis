/**
 * The Gemini engine.
 *
 * server.mjs was written against the Claude Agent SDK's `query()`: hand it an
 * async stream of user messages, get back an async stream of events. That SDK
 * is Claude-only, so running Anna on Gemini means supplying the other half of
 * the contract ourselves — this file. `geminiQuery` takes the same input and
 * yields the same event shapes (`stream_event` text deltas, tool_use starts,
 * tool_result echoes, one `result` per turn), so everything downstream of it —
 * the permission gate, the HUD announcements, barge-in settling, the socket
 * protocol — runs unchanged.
 *
 * What it adds, since the Agent SDK normally does it:
 *   1. An MCP client. Every server handed in is connected and its tools are
 *      turned into Gemini function declarations. In-process servers (the HUD,
 *      the ui_* controls, Chrome, the camera) are reached over an in-memory
 *      transport; the stdio/http/sse servers from ~/.claude.json are spawned
 *      or dialled the usual way.
 *   2. The tool loop. Stream a response, run whatever functions it called
 *      (through `canUseTool`, so decideTool still decides), feed the results
 *      back, repeat until it answers in words.
 *   3. Conversation memory, kept per connection like the SDK's session.
 *
 * Tool names keep Claude's `mcp__<server>__<tool>` shape on purpose: decideTool
 * and the announcement logic both read server and tool out of that string, and
 * a second naming scheme would mean a second copy of the policy.
 *
 * What it does NOT have: Claude Code's built-in tools (Read, Bash, WebFetch and
 * friends). Search and fetch come from the MCP servers (exa, serper, ...).
 */

import { GoogleGenAI } from '@google/genai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { createHash } from 'node:crypto'

/** A server that has not answered by now is treated as down for this session. */
const CONNECT_TIMEOUT_MS = 20_000
/** Image generation and long browser actions are slow; this is a ceiling, not a target. */
const CALL_TIMEOUT_MS = 5 * 60_000
/** Past this, a tool result is mostly noise and all of it is context the model pays for. */
const MAX_RESULT_CHARS = 60_000
/** Whole conversation turns kept in memory. Older ones are dropped at turn boundaries. */
const MAX_TURNS_KEPT = 24

export const geminiKey = () =>
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null

const debug = (...a) => {
  if (process.env.JARVIS_DEBUG === '1') console.log('[gemini]', ...a)
}

// ---------------------------------------------------------------------------
// MCP plumbing
// ---------------------------------------------------------------------------

function transportFor(cfg) {
  const kind = cfg.type ?? (cfg.url ? 'http' : 'stdio')
  if (kind === 'stdio') {
    // The Claude CLI hands its children the full environment, so this does too;
    // the MCP client's own default is a stripped-down subset that loses PATH
    // entries version managers add, and a server that cannot find `node` or
    // `uvx` fails in a way that looks like the server's fault.
    const env = {}
    for (const [k, v] of Object.entries({ ...process.env, ...(cfg.env ?? {}) })) {
      if (typeof v === 'string') env[k] = v
    }
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env,
      stderr: 'ignore',
    })
  }
  const url = new URL(cfg.url)
  const requestInit = cfg.headers ? { headers: cfg.headers } : undefined
  return kind === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit })
}

async function connectServer(name, cfg) {
  const client = new Client({ name: 'jarvis', version: '1.0.0' }, { capabilities: {} })
  try {
    if (cfg.type === 'sdk' && cfg.instance) {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await Promise.all([cfg.instance.connect(serverSide), client.connect(clientSide)])
    } else {
      await client.connect(transportFor(cfg))
    }
    const tools = []
    let cursor
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return { client, tools }
  } catch (err) {
    await client.close().catch(() => {})
    throw err
  }
}

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    )
  })

/** Gemini function names: letters, digits, _ . : - and at most 64 characters. */
function geminiName(full, taken) {
  let name = full.replace(/[^A-Za-z0-9_.:-]/g, '_')
  if (name.length > 64) {
    name = name.slice(0, 55) + '_' + createHash('sha1').update(full).digest('hex').slice(0, 8)
  }
  while (taken.has(name)) name = name.slice(0, 58) + '_' + (taken.size % 1000)
  return name
}

/** The one JSON-Schema keyword Gemini rejects outright that MCP servers emit freely. */
function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === '$comment') continue
      out[k] = cleanSchema(v)
    }
    return out
  }
  return node
}

function declarationFor(name, tool) {
  const decl = { name, description: String(tool.description ?? '').slice(0, 8000) || name }
  const schema = cleanSchema(tool.inputSchema ?? {})
  // A tool with no arguments is declared with no parameters, which every model
  // accepts, instead of an empty object schema, which some do not.
  if (schema.properties && Object.keys(schema.properties).length) {
    decl.parametersJsonSchema = schema
  }
  return decl
}

/** MCP result -> what Gemini can read back: one text blob plus any images. */
function readResult(res) {
  const texts = []
  const images = []
  for (const c of res?.content ?? []) {
    if (c.type === 'text') texts.push(c.text)
    else if (c.type === 'image') {
      images.push({ inlineData: { mimeType: c.mimeType ?? 'image/jpeg', data: c.data } })
    } else if (c.type === 'resource') texts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`)
    else texts.push(`[${c.type}]`)
  }
  if (!texts.length && res?.structuredContent) texts.push(JSON.stringify(res.structuredContent))
  let text = texts.join('\n')
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n[truncated]'
  return {
    text: text || (images.length ? 'See the image.' : 'Done.'),
    images,
    isError: res?.isError === true,
  }
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

/**
 * How much the model thinks, from the same JARVIS_EFFORT the Claude engine
 * reads.
 *
 * The knob differs by generation: 2.5 Flash takes a token budget (and can be
 * told zero), Gemini 3 Flash takes a named level. Pro models and anything
 * unrecognised are left on their own defaults rather than sent a field they
 * might reject.
 */
function thinkingFor(model, effort) {
  if (/gemini-2\.5-flash/.test(model)) {
    return { thinkingBudget: { low: 0, medium: 1024, high: 2048 }[effort] ?? 4096 }
  }
  if (/gemini-3|flash-latest/.test(model) && !/pro/.test(model)) {
    return { thinkingLevel: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }[effort] ?? 'HIGH' }
  }
  return undefined
}

// ---------------------------------------------------------------------------

/**
 * Same call shape as the Agent SDK's `query()`.
 *
 * @param {{ prompt: AsyncIterable<any>, options: any }} args
 */
export function geminiQuery({ prompt, options }) {
  const key = geminiKey()
  if (!key) throw new Error('GEMINI_API_KEY is not set')

  const ai = new GoogleGenAI({ apiKey: key })
  const model = options.model
  const maxSteps = options.maxTurns ?? 24

  /** The conversation, in Gemini's shape. Lives and dies with the connection. */
  const contents = []
  let starts = []

  /** gemini function name -> { client, fullName, tool } */
  const registry = new Map()
  const clients = []
  let declarations = []

  let aborter = new AbortController()
  let closed = false

  async function connectAll() {
    const entries = Object.entries(options.mcpServers ?? {})
    const status = await Promise.all(
      entries.map(async ([name, cfg]) => {
        try {
          const { client, tools } = await withTimeout(
            connectServer(name, cfg),
            CONNECT_TIMEOUT_MS,
            `connecting to ${name}`,
          )
          clients.push(client)
          for (const tool of tools) {
            const full = `mcp__${name}__${tool.name}`
            const g = geminiName(full, registry)
            registry.set(g, { client, fullName: full, tool })
          }
          return { name, status: 'connected' }
        } catch (err) {
          console.warn(`[jarvis] ${name} unavailable: ${err?.message ?? err}`)
          return { name, status: 'failed' }
        }
      }),
    )
    declarations = [...registry].map(([g, { tool }]) => declarationFor(g, tool))
    console.log(`[jarvis] gemini engine: ${declarations.length} tools from ${clients.length} servers`)
    return status
  }

  /** Images only matter for the turn they were captured in. */
  function pruneImages() {
    for (const c of contents) {
      c.parts = c.parts.map((p) => (p.inlineData ? { text: '[image omitted]' } : p))
    }
  }

  function trimHistory() {
    if (starts.length <= MAX_TURNS_KEPT) return
    const cut = starts[1]
    contents.splice(0, cut)
    starts = starts.slice(1).map((i) => i - cut)
  }

  async function* turn(userText) {
    const signal = aborter.signal
    trimHistory()
    const mark = contents.length
    starts.push(mark)
    contents.push({ role: 'user', parts: [{ text: userText }] })

    /** Throw the half-finished turn away so the next one starts from a valid history. */
    const rollback = () => {
      contents.length = mark
      starts = starts.filter((i) => i < mark)
    }

    let empties = 0
    let callSeq = 0

    for (let step = 0; step < maxSteps; step++) {
      const parts = []
      const calls = []
      let stepText = ''
      let finish = null

      let stream = null
      let activeModel = model
      let attempts = 0
      let enableGoogleSearch = process.env.JARVIS_GEMINI_GOOGLE_SEARCH === '1'
      while (attempts < 3) {
        try {
          const tools = [
            ...(declarations.length ? [{ functionDeclarations: declarations }] : []),
            ...(enableGoogleSearch ? [{ googleSearch: {} }] : []),
          ]
          stream = await ai.models.generateContentStream({
            model: activeModel,
            contents,
            config: {
              systemInstruction: options.systemPrompt,
              abortSignal: signal,
              ...(tools.length ? { tools } : {}),
              ...(thinkingFor(activeModel, options.effort)
                ? { thinkingConfig: thinkingFor(activeModel, options.effort) }
                : {}),
            },
          })
          break
        } catch (err) {
          attempts++
          const errMsg = String(err?.message ?? err)
          if (signal.aborted) {
            rollback()
            yield { type: 'result', subtype: 'success', result: stepText, total_cost_usd: null }
            return
          }
          if (enableGoogleSearch && (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED'))) {
            console.warn(`[jarvis] googleSearch grounding quota exceeded, retrying without googleSearch...`)
            enableGoogleSearch = false
            continue
          }
          if ((errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('429')) && attempts < 3) {
            const fallbacks = [
              activeModel === 'gemini-3.5-flash-lite' ? 'gemini-3.8-flash' : 'gemini-3.5-flash-lite',
              'gemini-3.8-flash',
              'gemini-3.5-flash',
            ]
            const nextModel = fallbacks[attempts - 1] || 'gemini-3.5-flash-lite'
            console.warn(`[jarvis] gemini model ${activeModel} busy, falling back to ${nextModel} (attempt ${attempts})...`)
            activeModel = nextModel
            await new Promise((r) => setTimeout(r, 500 * attempts))
            continue
          }
          console.error('[jarvis] gemini request failed:', errMsg)
          rollback()
          yield { type: 'result', subtype: 'error_during_execution', errors: [errMsg] }
          return
        }
      }

      try {
        for await (const chunk of stream) {
          if (signal.aborted) break
          const cand = chunk.candidates?.[0]
          finish = cand?.finishReason ?? finish
          for (const p of cand?.content?.parts ?? []) {
            if (p.thought) continue
            if (p.executableCode || p.codeExecutionResult || p.videoMetadata) continue
            if (p.functionCall) {
              const rawId = p.functionCall.id
              const call = {
                id: rawId ?? `call_${Date.now().toString(36)}_${callSeq++}`,
                rawId,
                name: p.functionCall.name,
                args: p.functionCall.args ?? {},
              }
              calls.push(call)
              parts.push(p)
              const entry = registry.get(call.name)
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_start',
                  content_block: {
                    type: 'tool_use',
                    id: call.id,
                    name: entry?.fullName ?? call.name,
                  },
                },
              }
              continue
            }
            if (typeof p.text === 'string' && p.text) {
              stepText += p.text
              yield {
                type: 'stream_event',
                event: { type: 'content_block_delta', delta: { type: 'text_delta', text: p.text } },
              }
              // Fold streamed fragments back into one part for the history, but
              // never across a thought signature: it belongs to the part it
              // arrived on and the API checks it.
              const prev = parts[parts.length - 1]
              if (prev && typeof prev.text === 'string' && !prev.thoughtSignature && !p.thoughtSignature) {
                prev.text += p.text
              } else {
                parts.push(p)
              }
            } else if (p.thoughtSignature) {
              parts.push(p)
            }
          }
        }
      } catch (err) {
        if (signal.aborted) {
          rollback()
          yield { type: 'result', subtype: 'success', result: stepText, total_cost_usd: null }
          return
        }
        console.error('[jarvis] gemini request failed:', err?.message ?? err)
        rollback()
        yield { type: 'result', subtype: 'error_during_execution', errors: [String(err?.message ?? err)] }
        return
      }

      if (signal.aborted) {
        rollback()
        yield { type: 'result', subtype: 'success', result: stepText, total_cost_usd: null }
        return
      }

      // No words and no calls: a blocked or malformed generation. One retry,
      // because MALFORMED_FUNCTION_CALL in particular is usually a one-off.
      if (!calls.length && !stepText.trim()) {
        debug('empty step, finishReason =', finish)
        if (empties++ < 1) continue
        rollback()
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: [`the model returned nothing (${finish ?? 'no reason given'})`],
        }
        return
      }

      contents.push({ role: 'model', parts })

      if (!calls.length) {
        pruneImages()
        yield { type: 'result', subtype: 'success', result: stepText.trim(), total_cost_usd: null }
        return
      }

      // Run the calls the model asked for, together, each through the gate.
      const done = await Promise.all(
        calls.map(async (call) => {
          const entry = registry.get(call.name)
          if (!entry) return { text: `Unknown tool ${call.name}.`, images: [], isError: true }
          try {
            const verdict = await options.canUseTool?.(entry.fullName, call.args, { signal })
            if (verdict && verdict.behavior === 'deny') {
              return { text: verdict.message ?? 'Blocked.', images: [], isError: true }
            }
            const res = await entry.client.callTool(
              { name: entry.tool.name, arguments: call.args },
              undefined,
              { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
            )
            return readResult(res)
          } catch (err) {
            return {
              text: `Tool failed: ${err?.message ?? err}`,
              images: [],
              isError: true,
            }
          }
        }),
      )

      if (signal.aborted) {
        rollback()
        yield { type: 'result', subtype: 'success', result: '', total_cost_usd: null }
        return
      }

      yield {
        type: 'user',
        message: {
          role: 'user',
          content: calls.map((call, i) => ({
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: done[i].isError,
          })),
        },
      }

      contents.push({
        role: 'user',
        parts: [
          ...calls.map((call, i) => ({
            functionResponse: {
              ...(call.rawId ? { id: call.rawId } : {}),
              name: call.name,
              response: done[i].isError ? { error: done[i].text } : { output: done[i].text },
            },
          })),
          ...done.flatMap((d) => d.images),
        ],
      })
    }

    // Ran out of steps without the model ever answering in words.
    pruneImages()
    yield { type: 'result', subtype: 'error_max_turns' }
  }

  async function* body() {
    try {
      const servers = await connectAll()
      yield { type: 'system', subtype: 'init', mcp_servers: servers }

      for await (const m of prompt) {
        if (closed) break
        const content = m?.message?.content
        const text =
          typeof content === 'string'
            ? content
            : (content ?? []).map((b) => b?.text ?? '').join('')
        if (!text.trim()) continue
        aborter = new AbortController()
        yield* turn(text)
      }
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
    }
  }

  const iterator = body()

  return {
    [Symbol.asyncIterator]: () => iterator,
    /** Stop the turn in flight. The turn still ends with a `result`. */
    async interrupt() {
      aborter.abort()
    },
    close() {
      closed = true
      aborter.abort()
      for (const c of clients) c.close().catch(() => {})
    },
  }
}
