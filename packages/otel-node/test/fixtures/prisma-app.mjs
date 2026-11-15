// The ESM form of prisma-app.cjs: the client arrives through the import hook.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function listUsers() {
  return prisma.user.findMany({ take: 10 })
}

listUsers().then(() => setTimeout(() => process.exit(0), 600))
