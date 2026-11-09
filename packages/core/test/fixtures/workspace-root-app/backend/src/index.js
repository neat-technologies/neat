const express = require('express')
const app = express()
app.get('/rides', (_req, res) => res.json([]))
app.listen(3000)
