import { Router, Request, Response } from 'express'

const router = Router()

router.get('/alpha', (req: Request, res: Response) => res.json({ ok: true }))
router.post('/alpha', (req: Request, res: Response) => res.status(201).end())

export default router
