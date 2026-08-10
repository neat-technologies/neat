package main

import "github.com/labstack/echo/v4"

func main() {
	e := echo.New()
	e.GET("/orders/:id", getOrder)
	e.POST("/orders", createOrder)

	admin := e.Group("/admin")
	admin.GET("/users/:id", getUser)

	v1 := admin.Group("/v1")
	v1.DELETE("/users/:id", deleteUser)
}

func getOrder(c echo.Context) error   { return nil }
func createOrder(c echo.Context) error { return nil }
func getUser(c echo.Context) error     { return nil }
func deleteUser(c echo.Context) error  { return nil }
