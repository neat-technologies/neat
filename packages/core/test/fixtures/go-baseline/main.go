package main

import (
	"database/sql"
	"example.com/orders-api/internal/store"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	api := r.Group("/api")
	api.GET("/orders/:id", getOrder)
	api.POST("/orders", createOrder)
	_ = store.Open()
}

func getOrder(c *gin.Context) {
	var db *sql.DB
	_, _ = db.Query("SELECT id FROM orders WHERE id = ?", c.Param("id"))
}

func createOrder(c *gin.Context) {}
