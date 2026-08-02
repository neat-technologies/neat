import { Router } from 'express'

// This router is never mounted anywhere. Its route is extracted per-file at its
// declared path; no prefix is fabricated for an un-mounted router (ADR-160).
const router = Router()

router.get('/standalone', (req, res) => res.end())

export default router
