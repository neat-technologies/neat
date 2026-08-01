// The defining module: a base class to extend, an abstract class used as an
// implemented contract, a plain interface, and a plain function to call. All
// heavily type-annotated so extraction runs on the real TypeScript grammar.

export abstract class BaseWidget<Props = unknown> {
  protected props: Props

  constructor(props: Props) {
    this.props = props
  }

  abstract render(): string
}

// An abstract class used as a `implements` contract. Unlike an interface, an
// abstract class IS a SymbolNode (kind 'class'), so an IMPLEMENTS edge can
// resolve onto it.
export abstract class Comparable<T> {
  abstract compareTo(other: T): number
}

// A real interface — NOT a SymbolNode per ADR-158 §2. A class that `implements`
// this must produce no IMPLEMENTS edge (the never-guess boundary).
export interface Serializable {
  serialize(): string
}

export function formatLabel(value: string, upper: boolean): string {
  return upper ? value.toUpperCase() : value
}
