import { Router } from 'express'

const router = Router()

router.get('/cfg', (req, res) => res.json({}))

export default router
