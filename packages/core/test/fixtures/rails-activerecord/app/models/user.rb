class User < ApplicationRecord
  has_many :orders
  has_one :profile
end
