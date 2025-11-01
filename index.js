import { Website } from '@spider-rs/spider-rs'

const EMAIL_RE = /(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(?![a-z0-9@._%+-])/gi

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

async function crawlAndFindEmails(url) {
  const website = new Website(url).withBudget({ '*': 25 }).build()

  const emails = new Set()
  const onPage = (_err, page) => {
    if (!page || !page.content) return
    console.log(`processed ${page.url}`)
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

const url = 'https://apexsunsolutions.com/'
crawlAndFindEmails(url)
  .then((emails) => {
    console.log(emails)
  })
  .catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
