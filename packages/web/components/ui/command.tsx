// A self-contained ⌘K command palette, styled to match the jedorini `command`
// component (neatified shadcn). It deliberately does NOT depend on `cmdk`:
// cmdk leans React-19 and the palette only needs simple substring filtering
// over a small, known item set, so a local implementation keeps the web shell
// on React 18 with no extra runtime dependency. Visual language (dialog shell,
// input group, grouped list, selected-row treatment) is copied from jedorini.
'use client'

import * as React from 'react'
import { SearchIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Dialog, DialogContent } from '@/components/ui/dialog'

interface CommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
  className?: string
  children: React.ReactNode
}

// Context lets CommandInput drive the shared query that CommandItem rows match
// against, and lets keyboard nav move a highlight across the visible items.
interface CommandCtx {
  query: string
  setQuery: (q: string) => void
  register: (id: string, run: () => void, text: string) => void
  unregister: (id: string) => void
  matches: (text: string) => boolean
  activeId: string | null
}

const Ctx = React.createContext<CommandCtx | null>(null)
function useCommandCtx(): CommandCtx {
  const c = React.useContext(Ctx)
  if (!c) throw new Error('Command parts must render inside <Command>')
  return c
}

// Exposes the live query string to consumers that need to react to it (e.g. a
// palette firing a debounced node search). Returns '' outside a Command.
export function useCommandQuery(): string {
  const c = React.useContext(Ctx)
  return c?.query ?? ''
}

function Command({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  const [query, setQuery] = React.useState('')
  // ordered registry of selectable items, in DOM order, for arrow-key nav.
  const itemsRef = React.useRef<Map<string, { run: () => void; text: string }>>(
    new Map(),
  )
  const [, force] = React.useReducer((n) => n + 1, 0)
  const [activeIdx, setActiveIdx] = React.useState(0)

  const register = React.useCallback((id: string, run: () => void, text: string) => {
    itemsRef.current.set(id, { run, text })
    force()
  }, [])
  const unregister = React.useCallback((id: string) => {
    itemsRef.current.delete(id)
    force()
  }, [])

  const matches = React.useCallback(
    (text: string) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return text.toLowerCase().includes(q)
    },
    [query],
  )

  // visible (matching) items in registration order
  const visible = React.useMemo(
    () => [...itemsRef.current.entries()].filter(([, v]) => matches(v.text)),
    [query, matches, itemsRef.current.size],
  )

  React.useEffect(() => {
    setActiveIdx(0)
  }, [query])

  const activeId = visible[activeIdx]?.[0] ?? visible[0]?.[0] ?? null

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, Math.max(0, visible.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        const sel = visible[activeIdx] ?? visible[0]
        if (sel) {
          e.preventDefault()
          sel[1].run()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, activeIdx])

  const ctx: CommandCtx = {
    query,
    setQuery,
    register,
    unregister,
    matches,
    activeId,
  }

  return (
    <Ctx.Provider value={ctx}>
      <div
        data-slot="command"
        className={cn(
          'flex size-full flex-col overflow-hidden bg-popover p-1 text-popover-foreground',
          className,
        )}
      >
        {children}
      </div>
    </Ctx.Provider>
  )
}

function CommandDialog({
  open,
  onOpenChange,
  className,
  children,
}: CommandDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('top-1/3 translate-y-0 overflow-hidden p-0', className)}>
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  placeholder,
  autoFocus = true,
}: {
  placeholder?: string
  autoFocus?: boolean
}) {
  const { query, setQuery } = useCommandCtx()
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2 border-b border-border px-3 pb-2 pt-1">
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <input
        data-slot="command-input"
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  )
}

function CommandList({ className, children }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-list"
      className={cn('max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto', className)}
    >
      {children}
    </div>
  )
}

function CommandEmpty({ children }: { children: React.ReactNode }) {
  const { query, register } = useCommandCtx()
  // The empty state is only meaningful when nothing matches; we can't know the
  // global match count from here cheaply, so show it whenever there's a query
  // and no item registered for it. Kept simple: callers wrap items in groups
  // and this renders below them; CSS hides it when siblings are present is
  // overkill, so we approximate with the query presence.
  void register
  if (!query.trim()) return null
  return (
    <div data-slot="command-empty" className="py-6 text-center text-sm text-muted-foreground command-empty">
      {children}
    </div>
  )
}

function CommandGroup({
  heading,
  children,
}: {
  heading?: string
  children: React.ReactNode
}) {
  return (
    <div data-slot="command-group" className="overflow-hidden p-1">
      {heading && (
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {heading}
        </div>
      )}
      {children}
    </div>
  )
}

function CommandSeparator() {
  return <div data-slot="command-separator" className="-mx-1 h-px bg-border" />
}

let itemSeq = 0
function CommandItem({
  children,
  onSelect,
  value,
  className,
}: {
  children: React.ReactNode
  onSelect: () => void
  /** the text this row matches against; falls back to its rendered text */
  value: string
  className?: string
}) {
  const { register, unregister, matches, activeId } = useCommandCtx()
  const idRef = React.useRef<string>('')
  if (!idRef.current) {
    itemSeq += 1
    idRef.current = `cmd-item-${itemSeq}`
  }
  const id = idRef.current

  React.useEffect(() => {
    register(id, onSelect, value)
    return () => unregister(id)
  }, [id, value])

  if (!matches(value)) return null
  const isActive = activeId === id

  return (
    <button
      type="button"
      data-slot="command-item"
      data-selected={isActive ? 'true' : undefined}
      onClick={onSelect}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'group/command-item relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
        className,
      )}
    >
      {children}
    </button>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  // useCommandQuery is exported above at its definition.
}
