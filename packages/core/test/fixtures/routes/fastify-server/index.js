const Fastify = require('fastify')

const fastify = Fastify()

fastify.get('/ping', async () => ({ pong: true }))

fastify.route({
  method: 'DELETE',
  url: '/items/:itemId',
  handler: async () => ({ deleted: true }),
})

module.exports = fastify
