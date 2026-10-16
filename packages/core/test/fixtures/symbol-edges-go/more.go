package app

// A second file in the same package. build() in edges.go calls extra(); the
// producer leaves that cross-file call unclaimed (same-package cross-file
// resolution is a deferred rung — no Go package symbol index yet).
func extra() int {
	return 7
}
