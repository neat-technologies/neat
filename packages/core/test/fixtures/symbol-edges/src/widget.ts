import { BaseWidget, Comparable, Serializable, formatLabel } from './base.js'
// An unresolvable external import — a bare specifier that resolves to no
// intra-service file. A call to it must produce no CALLS edge.
import { renderExternal } from 'some-external-ui-lib'

// Cross-file heritage: extends an imported base class and implements an imported
// abstract-class contract (both resolve) plus a plain interface (must NOT
// resolve — interfaces are not SymbolNodes).
export class Widget<Props = unknown>
  extends BaseWidget<Props>
  implements Comparable<Widget<Props>>, Serializable
{
  render(): string {
    // Method call on a typed receiver — needs the receiver's type to resolve,
    // so it must produce NO symbol CALLS edge.
    const label = this.decorate('widget')
    // Call into an unresolvable external import — NO edge.
    renderExternal(label)
    return label
  }

  compareTo(_other: Widget<Props>): number {
    return 0
  }

  serialize(): string {
    return 'widget'
  }

  private decorate(name: string): string {
    return `[${name}]`
  }
}

// Same-file helper, the confident same-file CALLS target.
function helper(prefix: string): string {
  return `${prefix}!`
}

// A top-level function that calls a same-file function and an imported function.
export function buildWidget(name: string): string {
  const decorated = helper(name)
  return formatLabel(decorated, true)
}
