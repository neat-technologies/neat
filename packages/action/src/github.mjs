// Posting to the pull request: one sticky comment per marker, edited in place on
// every run instead of piling up.

import { TOKEN } from './config.mjs'

async function githubApi(method, url, body) {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'neat-action',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status}`)
  return res.json()
}

export async function postSticky(owner, repo, prNumber, marker, bodyText) {
  const comments = await githubApi(
    'GET',
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
  )
  const existing = comments.find((c) => (c.body || '').includes(marker))
  if (existing) {
    await githubApi('PATCH', `/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      body: bodyText,
    })
  } else {
    await githubApi('POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      body: bodyText,
    })
  }
}
