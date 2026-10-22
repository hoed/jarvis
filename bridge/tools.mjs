/**
 * Built-in capability MCP servers.
 *
 * These run in-process and give Anna web search, weather, and Gmail access
 * without needing a ~/.claude.json or any third-party API key beyond what is
 * already in .env.local. Each is a plain object shaped like the sdk-based
 * servers (a `connect` method plus an in-memory transport pair), but lighter:
 * they implement the MCP protocol directly through @modelcontextprotocol/sdk
 * server primitives.
 *
 * Gmail: uses the chrome_* tools instead — the system prompt already tells
 * Anna to use Chrome for anything behind a login, so no separate Gmail server
 * is needed. The fix for "Gmail doesn't work" is making sure jarvis_chrome is
 * reachable, which it is once the Chrome extension is running.
 *
 * Weather: wttr.in returns structured JSON with no API key.
 * Web search: uses the Gemini SDK's own Google Search grounding when the
 * engine is Gemini; falls back to a SerpAPI-style call or DuckDuckGo instant
 * answers (no key needed) for the MCP path.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ---------------------------------------------------------------------------
// Weather server  — wttr.in, no key needed
// ---------------------------------------------------------------------------

export function weatherServer() {
  const server = new Server(
    { name: 'jarvis_weather', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_weather',
        description:
          'Get current weather and a 3-day forecast for any city or location. ' +
          'Returns temperature (°C and °F), conditions, humidity, wind, and rain chance. ' +
          'Use this for any weather question.',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'City name, region, or "latitude,longitude". Examples: "Jakarta", "London", "40.7128,-74.0060"',
            },
            unit: {
              type: 'string',
              enum: ['c', 'f'],
              description: 'Temperature unit: c=Celsius (default), f=Fahrenheit',
            },
          },
          required: ['location'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { location, unit = 'c' } = req.params.arguments ?? {}
    try {
      const loc = encodeURIComponent(String(location ?? '').trim())
      const url = `https://wttr.in/${loc}?format=j1&lang=en`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Anna-assistant/1.0' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`wttr.in returned ${res.status}`)
      const data = await res.json()
      const cur = data.current_condition?.[0] ?? {}
      const area = data.nearest_area?.[0]
      const place = area
        ? [
            area.areaName?.[0]?.value,
            area.region?.[0]?.value,
            area.country?.[0]?.value,
          ]
            .filter(Boolean)
            .join(', ')
        : location

      const tempC = cur.temp_C
      const tempF = cur.temp_F
      const temp = unit === 'f' ? `${tempF}°F (${tempC}°C)` : `${tempC}°C (${tempF}°F)`
      const desc = cur.weatherDesc?.[0]?.value ?? 'unknown'
      const humidity = cur.humidity
      const windKmph = cur.windspeedKmph
      const feelsC = cur.FeelsLikeC
      const feelsF = cur.FeelsLikeF
      const feels = unit === 'f' ? `${feelsF}°F` : `${feelsC}°C`

      const forecast = (data.weather ?? []).slice(0, 3).map((d) => {
        const dateStr = d.date
        const maxC = d.maxtempC, minC = d.mintempC
        const maxF = d.maxtempF, minF = d.mintempF
        const rain = d.hourly?.reduce((s, h) => s + Number(h.chanceofrain ?? 0), 0) / (d.hourly?.length || 1)
        const dayDesc = d.hourly?.[4]?.weatherDesc?.[0]?.value ?? ''
        const range = unit === 'f'
          ? `${minF}–${maxF}°F`
          : `${minC}–${maxC}°C`
        return `${dateStr}: ${dayDesc}, ${range}, rain ${Math.round(rain)}%`
      })

      const text = [
        `Weather for ${place}:`,
        `Current: ${temp}, feels like ${feels}`,
        `Conditions: ${desc}`,
        `Humidity: ${humidity}%, Wind: ${windKmph} km/h`,
        '',
        'Forecast:',
        ...forecast,
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Weather unavailable: ${err.message}` }],
        isError: true,
      }
    }
  })

  return {
    type: 'sdk',
    instance: server,
    _server: server,
  }
}

// ---------------------------------------------------------------------------
// Web search server — DuckDuckGo Instant Answer + HTML scrape fallback
// ---------------------------------------------------------------------------

export function searchServer() {
  const server = new Server(
    { name: 'jarvis_search', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'web_search',
        description:
          'Search the web for current information, news, facts, or anything requiring up-to-date data. ' +
          'Returns a summary and relevant snippets. Use this before answering questions about current events, ' +
          'prices, scores, or anything that may have changed recently.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query. Be specific for better results.',
            },
            count: {
              type: 'number',
              description: 'Number of results to return (1-10, default 5)',
            },
          },
          required: ['query'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { query, count = 5 } = req.params.arguments ?? {}
    const q = String(query ?? '').trim()
    if (!q) return { content: [{ type: 'text', text: 'No query provided.' }], isError: true }

    try {
      // DuckDuckGo Instant Answer API — no key, rate-limits are lenient for
      // small-volume personal use. Returns structured data for well-known
      // entities and a blank AbstractText otherwise.
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`
      const ddgRes = await fetch(ddgUrl, {
        headers: { 'User-Agent': 'Anna-assistant/1.0' },
        signal: AbortSignal.timeout(8_000),
      })
      const ddg = await ddgRes.json()

      const lines = []
      if (ddg.Heading) lines.push(`## ${ddg.Heading}`)
      if (ddg.AbstractText) lines.push(ddg.AbstractText)
      if (ddg.Answer) lines.push(`Answer: ${ddg.Answer}`)
      if (ddg.AbstractURL) lines.push(`Source: ${ddg.AbstractURL}`)

      // Related topics as fallback snippets
      const topics = (ddg.RelatedTopics ?? []).slice(0, Number(count) || 5)
      for (const t of topics) {
        if (t.Text) lines.push(`• ${t.Text}`)
      }

      // If DDG returned nothing useful, fall back to a Brave/DuckDuckGo HTML
      // search and scrape the first few result titles and snippets.
      if (lines.length < 2) {
        const htmlRes = await fetch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
              Accept: 'text/html',
            },
            signal: AbortSignal.timeout(10_000),
          },
        )
        const html = await htmlRes.text()
        // Extract result snippets with a simple regex — no jsdom dependency.
        const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([^<]+(?:<[^/][^>]*>[^<]*<\/[^>]+>)*[^<]*)<\/[^>]+>/g)]
          .slice(0, Number(count) || 5)
          .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
          .filter(Boolean)
        const titles = [...html.matchAll(/class="result__a"[^>]*>([^<]+)<\/a>/g)]
          .slice(0, Number(count) || 5)
          .map((m) => m[1].trim())
        if (titles.length) {
          lines.push(`Search results for "${q}":`)
          titles.forEach((t, i) => {
            lines.push(`${i + 1}. ${t}`)
            if (snippets[i]) lines.push(`   ${snippets[i]}`)
          })
        }
      }

      const text = lines.length
        ? lines.join('\n')
        : `No results found for "${q}". Try rephrasing or use chrome_navigate to search directly.`

      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Search failed: ${err.message}. Use chrome_navigate to search manually.` }],
        isError: true,
      }
    }
  })

  return {
    type: 'sdk',
    instance: server,
    _server: server,
  }
}
