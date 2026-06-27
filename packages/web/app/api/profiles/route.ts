import { discoverProfiles, DEMO } from '../../../lib/proxy'
import { FIXTURE_PROFILES } from '../../../lib/fixtures'

// ADR-101 — the daemon-discovery enumerator (was `/api/projects`). Enumerates
// `~/.neat/daemons/*.json` → one profile per per-project daemon
// (`{ project, endpoint, status }`). This is the only local↔hosted swap point:
// hosted replaces this source with the platform's project list. No
// `~/.neat/projects.json` registry dependency.
//
// The switcher (TopBar) lists what this returns; resolveProfile confirms
// reachability before auto-selecting, so a stale `running` record here never
// cold-opens onto a dead endpoint (#419).
export async function GET(): Promise<Response> {
  const profiles = await discoverProfiles()
  if (profiles.length === 0 && DEMO) {
    return Response.json(FIXTURE_PROFILES)
  }
  return Response.json(profiles)
}
