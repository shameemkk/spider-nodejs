import cluster from 'node:cluster'
import os from 'node:os'
import express from 'express'
import { Website } from '@spider-rs/spider-rs'
import cors from 'cors'
import dotenv from 'dotenv'

// Load environment variables from .env file quietly
dotenv.config({ quiet: true })

const EMAIL_RE = /(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(?![a-z0-9@._%+-])/gi
const DEBUG = process.env.DEBUG === 'true' || true

function extractEmails(htmlOrText) {
  const found = new Set()
  if (!htmlOrText) return []
  let m
  while ((m = EMAIL_RE.exec(htmlOrText)) !== null) {
    let email = (m[1] || '').trim().toLowerCase().replace(/[),.;:'"!?]+$/, '')
    if (email) found.add(email)
  }
  return [...found]
}

async function crawlAndFindEmails(url, maxPages = 25) {
  const website = new Website(url).withBudget({ '*': maxPages }).build()

  const emails = new Set()
  const onPage = (_err, page) => {
    if (!page || !page.content) return
    if (DEBUG) console.log(`processed ${page.url}`)
    for (const e of extractEmails(page.content)) emails.add(e)
  }

  try {
    // runInBackground=false, headlessChrome=false
    await website.crawl(onPage, false, false)
    return [...emails]
  } finally {
    await cleanupWebsite(website)
  }
}

async function cleanupWebsite(website) {
  try { website.clear() } catch (err) { console.warn('warning while clearing crawler state:', err) }
  try { website.clearData() } catch (err) { if (err && err.message && !/clearData/.test(err.message)) console.warn('warning while clearing crawler data:', err) }
  try { website.drainLinks() } catch { /* best-effort */ }
}

// Exports: app will be assigned in worker; keep top-level reference for ESM exports
let app = null

// Configuration
const DEFAULT_PORT = 3000
const envPort = Number.parseInt(process.env.PORT ?? '', 10)
const PORT = Number.isFinite(envPort) ? envPort : DEFAULT_PORT
const CPU_COUNT = Number.parseInt(process.env.WEB_CONCURRENCY ?? '', 10) || Math.max(1, os.cpus().length || 1)
const MAX_CONCURRENT_REQUESTS = Number.parseInt(process.env.MAX_CONCURRENT_REQUESTS ?? '', 10) || 1000

// Cluster master: monitor total concurrent requests and restart workers when threshold is exceeded
if (cluster.isPrimary) {
  console.log(`Master ${process.pid} starting - spawning ${CPU_COUNT} workers`)

  // Keep track of active requests across all workers
  const workerActive = new Map()

  let totalActive = 0
  let isRestarting = false

  function recalcTotal() {
    totalActive = 0
    for (const v of workerActive.values()) totalActive += v
    return totalActive
  }

  // Fork workers
  for (let i = 0; i < CPU_COUNT; i++) {
    const w = cluster.fork()
    workerActive.set(w.id, 0)
  }

  // Handle messages from workers about their active request counts
  cluster.on('message', (worker, message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'delta') {
      const prev = workerActive.get(worker.id) || 0
      const next = Math.max(0, prev + (Number(message.delta) || 0))
      workerActive.set(worker.id, next)
      const tot = recalcTotal()
      if (process.env.DEBUG) console.log(`Master: worker ${worker.id} delta=${message.delta} -> worker=${next} total=${tot}`)

      if (!isRestarting && tot >= MAX_CONCURRENT_REQUESTS) {
        isRestarting = true
        console.warn(`Master: total concurrent requests ${tot} >= ${MAX_CONCURRENT_REQUESTS}, restarting workers...`)
        // Instruct workers to shutdown gracefully; cluster 'exit' will spawn replacements
        for (const id in cluster.workers) {
          const wk = cluster.workers[id]
          if (wk && wk.isConnected()) wk.send({ type: 'shutdown' })
        }
      }
    }
  })

  // Respawn worker when it exits
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Master: worker ${worker.id} (pid ${worker.process.pid}) exited code=${code} signal=${signal}`)
    workerActive.delete(worker.id)
    // spawn a replacement to keep CPU_COUNT
    const nw = cluster.fork()
    workerActive.set(nw.id, 0)
    // once we have fresh workers, reset restarting flag
    if (isRestarting) {
      // small delay to let new workers initialize
      setTimeout(() => { isRestarting = false; }, 2000)
    }
  })

} else {
  // Worker: create express app and report active requests to master
  app = express()
  app.use(cors())
  app.use(express.json())

  let activeRequests = 0
  let shuttingDown = false
  let server = null

  function reportDelta(delta) {
    activeRequests = Math.max(0, activeRequests + delta)
    if (process.send) process.send({ type: 'delta', delta })
  }

  app.get('/health', (_req, res) => { res.json({ status: 'ok' }) })

  app.get('/', (_req, res) => {
    res.json({ endpoints: { 'GET /health': { description: 'Health check endpoint', response: { status: 'ok' } }, 'POST /crawl': { description: 'Crawls a website to find email addresses' } } })
  })

  app.post('/crawl', async (req, res) => {
    if (shuttingDown) {
      res.setHeader('Connection', 'close')
      return res.status(503).json({ error: 'server is restarting' })
    }

    reportDelta(1)
    try {
      const { url, maxPages } = req.body || {}
      if (typeof url !== 'string' || url.trim().length === 0) {
        res.status(400).json({ error: 'url is required' })
        return
      }
      let normalizedUrl
      try { normalizedUrl = new URL(url.trim()).toString() } catch { res.status(400).json({ error: 'url must be a valid absolute URL' }); return }

      try {
        const emails = await crawlAndFindEmails(normalizedUrl, maxPages)
        res.json({ url: normalizedUrl, count: emails.length, emails })
      } catch (err) {
        if (err && err.message && /maxPages/.test(err.message)) { res.status(400).json({ error: err.message }); return }
        console.error('error while crawling:', err)
        res.status(502).json({ error: 'failed to crawl url' })
      }

    } finally {
      reportDelta(-1)
      // if shutting down and no active requests, exit
      if (shuttingDown && activeRequests === 0) process.exit(0)
    }
  })

  // graceful shutdown message from master
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      console.log(`Worker ${cluster.worker.id} pid=${process.pid} received shutdown`) 
      shuttingDown = true
      // Stop accepting new connections
      try { server && server.close() } catch (e) { /* ignore */ }
      // if no active requests, exit now
      if (activeRequests === 0) process.exit(0)
      // otherwise, worker will exit once activeRequests drops to 0 in request completion
    }
  })

  // Start server
  server = app.listen(PORT, () => {
    console.log(`Worker ${cluster.worker.id} pid=${process.pid} listening on port ${PORT}`)
  })

}

// top-level export (works for ESM): `app` will be null in the master process and assigned in workers
export { app, crawlAndFindEmails }
