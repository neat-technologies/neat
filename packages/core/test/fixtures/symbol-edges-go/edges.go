// A Go service exercising the symbol-edge producer's precision discipline: a
// same-file bare call mints a CALLS, a forward-declared same-file call also
// resolves, and a recursive self-call, a method selector call, a builtin call, and
// a cross-file same-package call all mint nothing.
package app

import "fmt"

func helper(x int) int {
	return x * 2
}

func build() int {
	a := helper(21) // same-file bare call -> CALLS build->helper
	b := tally()    // forward-declared same-file call -> CALLS build->tally
	c := extra()    // cross-file same-package call -> deferred rung, no edge
	return a + b + c
}

func tally() int {
	return 0
}

func loop(n int) int {
	if n <= 0 {
		return 0
	}
	return loop(n - 1) // recursion -> no self-loop edge
}

type Server struct{}

func (s *Server) Render() string { return "ok" }

func describe(s *Server) {
	_ = s.Render()         // method selector -> no edge
	fmt.Println(len("hi")) // builtin + pkg selector -> no edge
}
