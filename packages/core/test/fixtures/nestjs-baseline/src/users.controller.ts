import { All, Controller, Get as Read, Post } from '@nestjs/common'

const COMPUTED_PATH = 'computed'

@Controller(['users', 'members'])
export class UsersController {
  @Read(':id')
  async findOne() {
    return fetch('https://inventory.internal/items')
  }

  @Post()
  create() {
    return { created: true }
  }

  @All(['health', 'ready'])
  readiness() {
    return { ready: true }
  }

  @Read(COMPUTED_PATH)
  computed() {
    return { hidden: true }
  }
}
