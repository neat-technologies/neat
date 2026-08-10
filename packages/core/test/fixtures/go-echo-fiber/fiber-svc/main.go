package main

import "github.com/gofiber/fiber/v2"

func main() {
	app := fiber.New()
	app.Get("/orders/:id", getOrder)
	app.Post("/orders", createOrder)

	api := app.Group("/api")
	api.Get("/orders/:id?", getOrderOpt)

	v2 := api.Group("/v2")
	v2.Get("/files/*", listFiles)
}

func getOrder(c *fiber.Ctx) error    { return nil }
func createOrder(c *fiber.Ctx) error { return nil }
func getOrderOpt(c *fiber.Ctx) error { return nil }
func listFiles(c *fiber.Ctx) error   { return nil }
