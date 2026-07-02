const express = require('express')

const app = express()

app.get('/health', (req, res) => {
  res.send('ok')
})

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id })
})

app.post('/users', (req, res) => {
  res.status(201).json({ created: true })
})

module.exports = app
