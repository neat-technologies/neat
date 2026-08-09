class Account < ApplicationRecord
  self.table_name = "legacy_accounts"

  belongs_to :owner, class_name: "User", foreign_key: "owner_ref"
end
