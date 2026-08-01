// A small, real service file: a top-level function, an arrow-const function,
// and a class with a constructor and a method. The symbol extractor should mint
// one SymbolNode per definition with its span, owned by this file.

export function createOrder(id: string) {
  const order = { id, status: 'new' }
  return order
}

export const listOrders = async () => {
  const rows: unknown[] = []
  return rows
}

export class OrderService {
  private db: unknown

  constructor(db: unknown) {
    this.db = db
  }

  async create(order: unknown) {
    // This line (inside `create`) is what a runtime span's code.line points at.
    return (this.db as { save: (o: unknown) => unknown }).save(order)
  }
}
