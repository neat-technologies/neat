import { Router, Request, Response } from 'express'

const router = Router()

router.get('/beta/:id', (req: Request, res: Response) => res.json({ id: req.params.id }))

export default router
