package main

import "net/http"

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /orders/{id}", getOrder)
	mux.HandleFunc("POST /orders", createOrder)
	mux.Handle("GET /assets/{path...}", http.FileServer(http.Dir("./static")))
	mux.HandleFunc("GET /{$}", home)

	// Pre-1.22 bare-prefix form — no method token, coarse subtree, deferred
	// (ADR-182). This mints no route.
	mux.HandleFunc("/legacy/", legacy)

	http.ListenAndServe(":8080", mux)
}

func getOrder(w http.ResponseWriter, r *http.Request)    {}
func createOrder(w http.ResponseWriter, r *http.Request) {}
func home(w http.ResponseWriter, r *http.Request)        {}
func legacy(w http.ResponseWriter, r *http.Request)      {}
