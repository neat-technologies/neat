class Order < ApplicationRecord
  belongs_to :user
  has_many :line_items
end
