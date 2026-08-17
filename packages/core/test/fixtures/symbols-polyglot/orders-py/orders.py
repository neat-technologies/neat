"""Orders service — Python symbol-grain extraction fixture (#1017)."""


def create_order(item_id):
    total = _compute_total(item_id)
    return {"item_id": item_id, "total": total}


async def list_orders():
    return await _fetch_all()


class OrderService:
    def __init__(self, db):
        self.db = db

    def create(self, order):
        # An observed DB span's code.lineno points inside this method.
        return self.db.save(order)

    @staticmethod
    def validate(order):
        return order is not None


def _compute_total(item_id):
    return len(item_id)


async def _fetch_all():
    return []
