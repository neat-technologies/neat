// The identity of one resolved dependency version (ecosystem, name, version), the
// shape every dependency-symbols producer takes (dependency-inventory.md §5). It
// lives in its own leaf module so extract.ts and internal-modules.ts can both name
// it without importing each other.
export interface DependencyRef {
  ecosystem: string
  name: string
  version: string
}
