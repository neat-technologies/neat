# Orders service — Ruby symbol-grain extraction fixture (#1019).

def create_order(item_id)
  total = compute_total(item_id)
  { item_id: item_id, total: total }
end

def list_orders
  fetch_all
end

class OrderService
  def initialize(db)
    @db = db
  end

  def create(order)
    # An observed DB span's code.lineno points inside this method.
    @db.save(order)
  end

  def self.validate(order)
    !order.nil?
  end
end

module Shop
  class Mailer
    def deliver(order)
      OrderService.new(nil).create(order)
    end
  end
end

class Billing::Invoice
  def render
    :ok
  end
end

def compute_total(item_id)
  item_id.length
end
