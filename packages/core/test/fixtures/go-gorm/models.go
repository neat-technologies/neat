package shop

import "gorm.io/gorm"

type User struct {
	gorm.Model
	Name      string
	Email     string `gorm:"column:email_address"`
	Password  string `gorm:"-"`
	Orders    []Order
	Languages []Language `gorm:"many2many:user_languages"`
}

type Order struct {
	gorm.Model
	Code      string
	UserID    uint
	User      User
	LineItems []LineItem
}

type LineItem struct {
	gorm.Model
	OrderID uint
	Qty     int
}

type Language struct {
	gorm.Model
	Code string
}

type APIKey struct {
	gorm.Model
	Token string
}

func migrate(db *gorm.DB) error {
	return db.AutoMigrate(&User{}, &Order{}, &LineItem{}, &Language{}, &APIKey{})
}
