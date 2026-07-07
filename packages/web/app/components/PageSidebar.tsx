'use client'

import { useRouter } from 'next/navigation'
import {
  GitBranchIcon,
  ShieldIcon,
  TriangleAlertIcon,
  SearchIcon,
  SettingsIcon,
  ShuffleIcon,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { NAV_GROUPS, type NavId } from '../../lib/nav'

// The icon rail became a real labeled page-nav sidebar (jedorini sidebar). The
// graph is one spatial page among list/table views — that's the multi-page
// SaaS shell the redo is built around.

const ICONS: Record<NavId, React.ComponentType<{ className?: string }>> = {
  graph: GitBranchIcon,
  divergences: ShuffleIcon,
  policies: ShieldIcon,
  incidents: TriangleAlertIcon,
  find: SearchIcon,
  settings: SettingsIcon,
}

// Most nav ids are views AppShell switches between in place (graph, policies,
// and the StubPage-rendered siblings). Incidents is the one nav id that's
// actually a standalone route (app/incidents/page.tsx) rather than an
// AppShell-internal view, so it needs a real navigation instead of the
// in-shell onNavigate callback.
const ROUTES: Partial<Record<NavId, string>> = {
  incidents: '/incidents',
}

interface PageSidebarProps {
  active: NavId
  onNavigate: (id: NavId) => void
  badges?: Partial<Record<NavId, number>>
}

export function PageSidebar({ active, onNavigate, badges = {} }: PageSidebarProps) {
  const router = useRouter()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between px-1">
          <span className="font-heading text-sm tracking-tight group-data-[collapsible=icon]:hidden">
            NEAT
          </span>
          <SidebarTrigger />
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = ICONS[item.id]
                  const isTodo = item.kind === 'todo'
                  const badge = badges[item.id]
                  const route = ROUTES[item.id]
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active === item.id}
                        tooltip={isTodo ? `${item.label} — coming soon` : item.label}
                        // #697: every nav entry is a normal, clickable button —
                        // todo-marked siblings route through to StubPage's
                        // honest "here's what's coming" copy (web-completeness
                        // #26 is satisfied by that placeholder being real and
                        // wired, not by disabling the entry).
                        onClick={() => {
                          if (route) router.push(route)
                          else onNavigate(item.id)
                        }}
                        render={<button type="button" />}
                      >
                        <Icon />
                        <span>{item.label}</span>
                        {isTodo && (
                          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground group-data-[collapsible=icon]:hidden">
                            soon
                          </span>
                        )}
                      </SidebarMenuButton>
                      {!isTodo && badge ? (
                        <SidebarMenuBadge>{badge > 9 ? '9+' : badge}</SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <span className="px-2 text-[10px] uppercase tracking-wider text-muted-foreground group-data-[collapsible=icon]:hidden">
          the fused graph · your agent&apos;s eyes
        </span>
      </SidebarFooter>
    </Sidebar>
  )
}
