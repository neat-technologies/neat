const express = require('express')

const app = express()

// A fully literal route — the control target the client hits with a literal URL.
app.get('/health', (req, res) => {
  res.send('ok')
})

// A literal collection route.
app.get('/charges', (req, res) => {
  res.json({ charges: [] })
})

// A collection item with a genuine path parameter. The client interpolates a
// real id into this — literal `/charges` anchors which route it means.
app.get('/charges/:id', (req, res) => {
  res.json({ id: req.params.id })
})

// A bare single-segment dynamic route. Any client URL that reconstructs to a
// lone `:param` (a computed first segment) collapses onto this one, which is
// the shape the confident false positive rides.
app.get('/:id', (req, res) => {
  res.json({ resource: req.params.id })
})

module.exports = app
