const express = require('express')
const { PrismaClient } = require('@prisma/client')

const app = express()
const prisma = new PrismaClient()

app.get('/', async (req, res) => {
  res.json({ ok: true })
})

app.listen(3000)
