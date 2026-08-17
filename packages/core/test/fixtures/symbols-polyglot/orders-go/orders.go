package orders

import "database/sql"

type Server struct {
	db *sql.DB
}

func NewServer(db *sql.DB) *Server {
	return &Server{db: db}
}

func (s *Server) CreateOrder(id string) error {
	// An observed DB span's code.lineno points inside this method.
	_, err := s.db.Exec("INSERT INTO orders (id) VALUES ($1)", id)
	return err
}

func (s *Server) ListOrders() ([]string, error) {
	return nil, nil
}

func computeTotal(id string) int {
	return len(id)
}
