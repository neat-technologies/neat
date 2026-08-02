import { Router } from 'express'

const router = Router()

router.get('/things', (req, res) => res.json([]))
router.post('/things', (req, res) => res.status(201).end())

export default router
