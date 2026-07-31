import { NestFactory } from '@nestjs/core'
import { UsersController } from './users.controller'

async function bootstrap() {
  const app = await NestFactory.create(UsersController)
  await app.listen(3000)
}

void bootstrap()
