package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()

	r.Get("/orders/{id}", getOrder)
	r.Post("/orders", createOrder)
	r.Get("/users/{id:[0-9]+}", getUser)
	r.Get("/files/*", listFiles)

	r.Route("/articles", func(r chi.Router) {
		r.Get("/{articleID}", getArticle)
		r.Group(func(r chi.Router) {
			r.Delete("/{articleID}", deleteArticle)
		})
	})

	// Mount is deferred (ADR-182): the mounted handler is opaque here, so no
	// /admin route is composed.
	r.Mount("/admin", http.FileServer(http.Dir("./static")))

	http.ListenAndServe(":3000", r)
}

func getOrder(w http.ResponseWriter, r *http.Request)      {}
func createOrder(w http.ResponseWriter, r *http.Request)   {}
func getUser(w http.ResponseWriter, r *http.Request)       {}
func listFiles(w http.ResponseWriter, r *http.Request)     {}
func getArticle(w http.ResponseWriter, r *http.Request)    {}
func deleteArticle(w http.ResponseWriter, r *http.Request) {}
