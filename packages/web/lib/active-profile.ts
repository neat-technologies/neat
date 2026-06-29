'use client'

import type { Profile } from './resolve-project'

// The active profile (ADR-101) — the one selection the whole shell shares.
// AppShell / IncidentsClient set it when resolution lands; authed-fetch and
// use-auth-gate read the profile's bearer from here. This module IS the
// local↔hosted auth seam: local discovery yields a token-less profile (the
// bearer, if any, comes from the per-profile store below); hosted supplies the
// bearer on the profile object itself. Same code path either way — only the
// profile SOURCE and where the token comes from differ.

let active: Profile | null = null

export function setActiveProfile(p: Profile | null): void {
  active = p
}

export function getActiveProfile(): Profile | null {
  return active
}

// Per-profile bearer store. ADR-101 drops the single `neat:authToken`; the
// token is keyed by the profile label so two local daemons behind different
// tokens never share one. Local default is no token (laptop dev / public-read).
function tokenKey(project: string): string {
  return `neat:authToken:${project}`
}

export function readProfileToken(project: string | null): string | null {
  if (!project) return null
  // Hosted: the bearer rides on the active profile object.
  if (active?.project === project && active.authToken) return active.authToken
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(tokenKey(project))
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

export function writeProfileToken(project: string, token: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(tokenKey(project), token)
  } catch {
    /* storage quota / private mode — caller's fetch will surface any failure */
  }
}

export function clearProfileToken(project: string | null): void {
  if (!project || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(tokenKey(project))
  } catch {
    /* ignore */
  }
}

// The profile label the shell is heading to before resolution lands: the URL
// `?project=` then `neat:lastProject` (web-multi-project §2.4 — the keys stay
// names). Lets use-auth-gate read a token synchronously on mount, keyed to the
// profile that is about to become active.
export function readInitialProfileName(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const url = new URLSearchParams(window.location.search).get('project')
    if (url) return url
    const stored = window.localStorage.getItem('neat:lastProject')
    if (stored) return stored
  } catch {
    /* private mode — no synchronous read */
  }
  return null
}

// The active profile's bearer — what authed-fetch attaches and use-auth-gate
// checks. Falls back to the profile the shell is resolving toward so a stored
// token is honored before the async resolution completes.
export function getActiveAuthToken(): string | null {
  if (active?.authToken) return active.authToken
  return readProfileToken(active?.project ?? readInitialProfileName())
}
