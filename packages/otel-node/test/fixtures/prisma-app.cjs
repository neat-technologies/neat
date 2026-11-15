// A CommonJS app on @prisma/client. References NEAT and OpenTelemetry nowhere.
// The test copies it next to the stub client; listUsers' findMany is the call
// site the query span should carry.
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function listUsers() {
  return prisma.user.findMany({ take: 10 })
}

listUsers().then(() => setTimeout(() => process.exit(0), 600))
