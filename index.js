import express from 'express'
import { Website } from '@spider-rs/spider-rs'
import cors from 'cors'
import dotenv from 'dotenv'

// Load environment variables from .env file with debug logging
dotenv.config({ quiet: true })

const EMAIL_RE = /(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(?![a-z0-9@._%+-])/gi

const DEBUG = process.env.DEBUG || true

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

async function crawlAndFindEmails(url, maxPages=25) {
  const website = new Website(url).withBudget({ '*': maxPages }).build()

  const emails = new Set()
  const onPage = (_err, page) => {
    if (!page || !page.content) return
    if (DEBUG) console.log(`processed ${page.url}`)
    for (const e of extractEmails(page.content)) emails.add(e)
  }

  try {
    // IMPORTANT: second arg = runInBackground -> set to false
    await website.crawl(onPage, false /* runInBackground */, false /* headlessChrome */)
    return [...emails]
  } finally {
    await cleanupWebsite(website)
  }
}

async function cleanupWebsite(website) {
  try {
    website.clear()
  } catch (err) {
    console.warn('warning while clearing crawler state:', err)
  }
  try {
    website.clearData()
  } catch (err) {
    if (err && err.message && !/clearData/.test(err.message)) {
      console.warn('warning while clearing crawler data:', err)
    }
  }
  try {
    website.drainLinks()
  } catch {
    // ignore; draining is best-effort
  }
}

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/', (_req, res) => {
  res.json({
    endpoints: {
      'GET /health': {
        description: 'Health check endpoint',
        response: { status: 'ok' }
      },
      'GET /': {
        description: 'API documentation endpoint',
        response: 'Returns this documentation'
      },
      'POST /crawl': {
        description: 'Crawls a website to find email addresses',
        requestBody: {
          url: 'string (required) - Valid absolute URL to crawl',
          maxPages: 'number (optional) - Maximum number of pages to crawl (default: 25)'
        },
        response: {
          url: 'string - Normalized URL that was crawled',
          count: 'number - Number of unique emails found',
          emails: 'string[] - Array of unique email addresses found'
        },
        errors: {
          400: [
            { error: 'url is required' },
            { error: 'url must be a valid absolute URL' },
            { error: 'maxPages error message' }
          ],
          502: { error: 'failed to crawl url' }
        }
      }
    }
  })
})

app.post('/crawl', async (req, res) => {
  const { url, maxPages } = req.body || {}
  if (typeof url !== 'string' || url.trim().length === 0) {
    res.status(400).json({ error: 'url is required' })
    return
  }

  let normalizedUrl
  try {
    normalizedUrl = new URL(url.trim()).toString()
  } catch {
    res.status(400).json({ error: 'url must be a valid absolute URL' })
    return
  }

  try {
    const emails = await crawlAndFindEmails(normalizedUrl, maxPages)
    res.json({ url: normalizedUrl, count: emails.length, emails })
  } catch (err) {
    if (err && err.message && /maxPages/.test(err.message)) {
      res.status(400).json({ error: err.message })
      return
    }

    console.error('error while crawling:', err)
    res.status(502).json({ error: 'failed to crawl url' })
  }
})

const DEFAULT_PORT = 3000
const envPort = Number.parseInt(process.env.PORT ?? '', 10)
const port = Number.isFinite(envPort) ? envPort : DEFAULT_PORT

app.listen(port, () => {
  console.log(`Server started on port ${port}`)
})

export { app, crawlAndFindEmails }
