import { Router } from 'express'
import alphaController from '../controllers/alpha.controller'
import betaController from '../controllers/beta.controller'

// A local aggregator router that mounts the controllers with no prefix, then
// the default export mounts the aggregator under '/api' — the RealWorld shape.
const api = Router().use(alphaController).use(betaController)

export default Router().use('/api', api)
