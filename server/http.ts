import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import type { PublicConfig } from '../shared/api.ts'
import type { Indexer } from './chain/indexer.ts'
import type { Db } from './db/index.ts'
import { roundHistory, roundProof, walletView } from './game/views.ts'
import type { Log } from './log.ts'
import type { Mode } from './config.ts'

const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
const signature = base58.min(64).max(90)
const address = base58.min(32).max(44)

/** RPC calls the browser needs. Anything else stays away from the paid endpoint. */
const RPC_METHODS = new Set([
  'getLatestBlockhash',
  'sendTransaction',
  'getTokenAccountBalance',
  'getAccountInfo',
  'getSignatureStatuses',
  'getBalance',
  'getBlockHeight',
  'isBlockhashValid',
  'simulateTransaction',
])

/** Small per-IP limiter. Good enough for one process behind one proxy. */
function rateLimiter(perMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (request: FastifyRequest): boolean => {
    const now = Date.now()
    const entry = hits.get(request.ip)
    if (!entry || entry.resetAt < now) {
      if (hits.size > 50_000) hits.clear()
      hits.set(request.ip, { count: 1, resetAt: now + 60_000 })
      return true
    }
    entry.count += 1
    return entry.count <= perMinute
  }
}

export interface HttpOptions {
  db: Db
  indexer: Indexer
  log: Log
  mode: Mode
  publicConfig: PublicConfig
  rpcUrl: string
  trustProxyHops: number
  /** Latest JSON state, already serialised. */
  state(): string
  role(): 'standby' | 'active' | 'draining'
  mockActions?: {
    rip(wallet: string, roundId: number): Promise<string>
    redeem(wallet: string, roundId: number, originSig: string): Promise<string>
  }
}

export interface Http {
  app: FastifyInstance
  broadcast(json: string): void
  /** Ends live streams so open pages reconnect, reaching the new server. */
  endStreams(): void
}

export async function buildHttp(opts: HttpOptions): Promise<Http> {
  const { db, indexer, log } = opts
  const app = Fastify({
    // Count hops rather than trusting everything, so a client can't fake its IP.
    trustProxy: opts.trustProxyHops > 0 ? (_address: string, hop: number) => hop < opts.trustProxyHops : false,
    bodyLimit: 256_000,
  })
  const clients = new Set<NodeJS.WritableStream>()
  const ripLimit = rateLimiter(120)
  const rpcLimit = rateLimiter(240)
  const readLimit = rateLimiter(600)

  /**
   * Docker's health check. A standby counts as healthy: that is what lets Swarm
   * stop the old server, which is what hands this one the database.
   */
  app.get('/health', async (_request, reply) => {
    const role = opts.role()
    let ok = role !== 'draining'
    if (role === 'active') {
      // A dead database fails at once. A slow one is not a failure.
      ok = await Promise.race([
        db.query('SELECT 1').then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(resolve, 2_000, true)),
      ])
    }
    return reply
      .code(ok ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({ ok, role, mode: opts.mode })
  })
  app.get('/api/config', async () => opts.publicConfig)
  app.get('/api/state', async (_request, reply) => reply.type('application/json').send(opts.state()))

  app.get('/api/stream', (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    reply.raw.write(`data: ${opts.state()}\n\n`)
    clients.add(reply.raw)
    request.raw.on('close', () => clients.delete(reply.raw))
  })

  /** A hint only speeds things up. The server reads the burn from the chain. */
  app.post('/api/rips', async (request, reply) => {
    if (!ripLimit(request)) return reply.code(429).send({ error: 'slow down' })
    const parsed = z.object({ signature }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid signature' })
    // Only the active server writes. The client retries, and the indexer finds it regardless.
    if (opts.role() !== 'active') return { result: 'pending' }
    return { result: await indexer.ingest(parsed.data.signature) }
  })

  app.get<{ Params: { address: string } }>('/api/wallet/:address', async (request, reply) => {
    if (!readLimit(request)) return reply.code(429).send({ error: 'slow down' })
    const parsed = address.safeParse(request.params.address)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid address' })
    return walletView(db, parsed.data)
  })

  app.get('/api/rounds', async () => roundHistory(db))

  app.get<{ Params: { id: string } }>('/api/rounds/:id', async (request, reply) => {
    const id = Number(request.params.id)
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid round' })
    const proof = await roundProof(db, id)
    return proof ?? reply.code(404).send({ error: 'no such round' })
  })

  if (opts.rpcUrl) {
    app.post('/rpc', async (request, reply) => {
      if (!rpcLimit(request)) return reply.code(429).send({ error: 'slow down' })
      const body = request.body as { method?: string } | null
      if (!body || Array.isArray(body) || !RPC_METHODS.has(String(body.method))) {
        return reply.code(403).send({ error: 'method not allowed' })
      }
      const upstream = await fetch(opts.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      return reply.code(upstream.status).type('application/json').send(await upstream.text())
    })
  }

  if (opts.mockActions) {
    const { rip, redeem } = opts.mockActions
    const ripBody = z.object({ wallet: address, roundId: z.number().int().positive() })
    app.post('/api/mock/rip', async (request, reply) => {
      const parsed = ripBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
      return { signature: await rip(parsed.data.wallet, parsed.data.roundId) }
    })
    app.post('/api/mock/redeem', async (request, reply) => {
      const parsed = ripBody.extend({ originSig: signature }).safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' })
      return { signature: await redeem(parsed.data.wallet, parsed.data.roundId, parsed.data.originSig) }
    })
  }

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      setHeaders(response, filePath) {
        // Assets are named by content hash. The page itself must always be fresh.
        const immutable = /[\\/]assets[\\/]/.test(filePath)
        response.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
    app.setNotFoundHandler((request, reply) => {
      const missing = request.url.startsWith('/api') || request.url.startsWith('/assets') || request.method !== 'GET'
      if (missing) return reply.code(404).send({ error: 'not found' })
      return reply.header('cache-control', 'no-cache').sendFile('index.html')
    })
  } else {
    log.warn('no web build found: run npm run build, or use npm run dev:web')
  }

  return {
    app,
    broadcast(json) {
      for (const client of clients) client.write(`data: ${json}\n\n`)
    },
    endStreams() {
      for (const client of clients) client.end()
      clients.clear()
    },
  }
}
