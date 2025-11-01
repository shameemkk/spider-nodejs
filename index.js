import { Website } from '@spider-rs/spider-rs'

// simple email regex (good balance of accuracy and speed)
const EMAIL_RE = /(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})(?![a-z0-9@._%+-])/gi

function extractEmails(htmlOrText) {
  const found = new Set()
  if (!htmlOrText) return []
  let match
  while ((match = EMAIL_RE.exec(htmlOrText)) !== null) {
    let email = (match[1] || '').trim().toLowerCase()
    if (!email) continue
    email = email.replace(/[),.;:'"!?]+$/, '')
    found.add(email)
  }
  return [...found]
}

async function crawlAndFindEmails(url) {
  const website = new Website(url)
    .withBudget({ '*': 20 }) // limit pages if you want
    .build()

  const emails = new Set()

  const onPage = (_err, page) => {
    if (!page || !page.content) return
    console.log(`processed ${page.url}`)
    const found = extractEmails(page.content)
    for (const e of found) emails.add(e)
  }

  await website.crawl(onPage)
  return [...emails]
}

// --- Run the crawler ---
const url = 'http://coastalcleaningservices.org/' // <--- change this
crawlAndFindEmails(url)
  .then((emails) => {
    console.log(emails)
  })
  .catch((err) => {
    console.error('Error:', err)
  })
