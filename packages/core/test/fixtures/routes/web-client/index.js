const axios = require('axios')

// GET with an interpolated path param — matches the server's `/users/:id`.
async function getUser(id) {
  const res = await fetch(`http://api-server:4000/users/${id}`)
  return res.json()
}

// POST with an explicit method option — matches the server's `POST /users`.
async function createUser(body) {
  return fetch('http://api-server:4000/users', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// axios method-call form — matches the server's `GET /health`.
async function health() {
  return axios.get('http://api-server:4000/health')
}

module.exports = { getUser, createUser, health }
