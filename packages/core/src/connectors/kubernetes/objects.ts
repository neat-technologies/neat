// The objects a k8s config fault lives in when no pod carries it (#1484, ADR-266):
// NetworkPolicies and ResourceQuotas in the namespace, the
// MutatingWebhookConfigurations that apply to it, the RBAC that binds its service
// accounts, the PriorityClasses its workloads run under (#1487), and the
// cluster's CoreDNS ConfigMap. Each becomes an InfraNode with
// its live spec as OBSERVED `observedSpec` (the #1481 path), so a change against a
// healthy snapshot shows in the graph diff. Read-only (`get`/`list`), and every
// read is a sharpener: a missing grant or a failed read skips that kind for the
// poll and leaves its nodes as they were.
//
// Field names are stable API (networking.k8s.io/v1, core/v1,
// admissionregistration.k8s.io/v1, rbac.authorization.k8s.io/v1), confirmed
// against the API reference. The `observedSpec` field names per kind are listed
// in connectors.md §10; readers key on them.

import type { ObservedSignal } from '../types.js'
import type { ResolvedK8sTransport } from './kubeconfig.js'
import { getResource, listResource } from './client.js'
import type { ConfigMap, Deployment, ObjectMeta, Pod } from './types.js'
import { K8S_OBJECT_TARGET_KIND, packK8sObjectName } from './types.js'

// ── shapes (the subset read) ─────────────────────────────────────────────────

export interface LabelSelectorRequirement {
  key?: string
  operator?: string
  values?: string[]
}

export interface FullLabelSelector {
  matchLabels?: Record<string, string>
  matchExpressions?: LabelSelectorRequirement[]
}

export interface NetworkPolicy {
  metadata?: ObjectMeta
  spec?: {
    podSelector?: FullLabelSelector
    policyTypes?: string[]
    ingress?: unknown[]
    egress?: unknown[]
  }
}

export interface ResourceQuota {
  metadata?: ObjectMeta
  spec?: { hard?: Record<string, string>; scopes?: string[] }
  status?: { hard?: Record<string, string>; used?: Record<string, string> }
}

export interface MutatingWebhook {
  name?: string
  failurePolicy?: string
  sideEffects?: string
  reinvocationPolicy?: string
  timeoutSeconds?: number
  matchPolicy?: string
  namespaceSelector?: FullLabelSelector
  objectSelector?: FullLabelSelector
  rules?: unknown[]
  clientConfig?: {
    url?: string
    service?: { namespace?: string; name?: string; path?: string; port?: number }
    caBundle?: string
  }
}

export interface MutatingWebhookConfiguration {
  metadata?: ObjectMeta
  webhooks?: MutatingWebhook[]
}

export interface PolicyRule {
  apiGroups?: string[]
  resources?: string[]
  resourceNames?: string[]
  verbs?: string[]
  nonResourceURLs?: string[]
}

export interface Role {
  metadata?: ObjectMeta
  rules?: PolicyRule[]
}

export interface RoleSubject {
  kind?: string
  name?: string
  namespace?: string
}

export interface RoleBinding {
  metadata?: ObjectMeta
  roleRef?: { kind?: string; name?: string; apiGroup?: string }
  subjects?: RoleSubject[]
}

export interface Namespace {
  metadata?: ObjectMeta
}

// scheduling.k8s.io/v1 — the fields at the top level, not under `spec`.
export interface PriorityClass {
  metadata?: ObjectMeta
  value?: number
  globalDefault?: boolean
  preemptionPolicy?: string
}

// ── paths ────────────────────────────────────────────────────────────────────

export function networkPoliciesPath(ns: string): string {
  return `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`
}
export function resourceQuotasPath(ns: string): string {
  return `/api/v1/namespaces/${ns}/resourcequotas`
}
export function rolesPath(ns: string): string {
  return `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles`
}
export function roleBindingsPath(ns: string): string {
  return `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`
}
export const MUTATING_WEBHOOKS_PATH = '/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations'
export const CLUSTER_ROLES_PATH = '/apis/rbac.authorization.k8s.io/v1/clusterroles'
export const CLUSTER_ROLE_BINDINGS_PATH = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'
export const COREDNS_CONFIGMAP_PATH = '/api/v1/namespaces/kube-system/configmaps/coredns'
export const PRIORITY_CLASSES_PATH = '/apis/scheduling.k8s.io/v1/priorityclasses'
export function namespacePath(ns: string): string {
  return `/api/v1/namespaces/${ns}`
}

// ── fetch ────────────────────────────────────────────────────────────────────

/** What one poll read; `undefined` for a kind whose read failed. */
export interface K8sConfigObjects {
  namespaceLabels?: Record<string, string>
  networkPolicies?: NetworkPolicy[]
  resourceQuotas?: ResourceQuota[]
  mutatingWebhooks?: MutatingWebhookConfiguration[]
  roles?: Role[]
  roleBindings?: RoleBinding[]
  clusterRoles?: Role[]
  clusterRoleBindings?: RoleBinding[]
  priorityClasses?: PriorityClass[]
  coreDns?: ConfigMap
}

async function optionalList<T>(
  transport: ResolvedK8sTransport,
  namespace: string,
  path: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch },
): Promise<T[] | undefined> {
  try {
    return await listResource<T>(transport, namespace, path, opts)
  } catch {
    return undefined
  }
}

export async function fetchConfigObjects(
  transport: ResolvedK8sTransport,
  namespace: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<K8sConfigObjects> {
  const [ns, networkPolicies, resourceQuotas, mutatingWebhooks, roles, roleBindings, clusterRoles, clusterRoleBindings, priorityClasses, coreDns] =
    await Promise.all([
      getResource<Namespace>(transport, namespace, namespacePath(namespace), opts),
      optionalList<NetworkPolicy>(transport, namespace, networkPoliciesPath(namespace), opts),
      optionalList<ResourceQuota>(transport, namespace, resourceQuotasPath(namespace), opts),
      optionalList<MutatingWebhookConfiguration>(transport, namespace, MUTATING_WEBHOOKS_PATH, opts),
      optionalList<Role>(transport, namespace, rolesPath(namespace), opts),
      optionalList<RoleBinding>(transport, namespace, roleBindingsPath(namespace), opts),
      optionalList<Role>(transport, namespace, CLUSTER_ROLES_PATH, opts),
      optionalList<RoleBinding>(transport, namespace, CLUSTER_ROLE_BINDINGS_PATH, opts),
      optionalList<PriorityClass>(transport, namespace, PRIORITY_CLASSES_PATH, opts),
      getResource<ConfigMap>(transport, namespace, COREDNS_CONFIGMAP_PATH, opts),
    ])
  // Every namespace carries `kubernetes.io/metadata.name` (k8s 1.21+), so a
  // webhook's namespaceSelector can be matched on that much without the read.
  const namespaceLabels = { 'kubernetes.io/metadata.name': namespace, ...(ns?.metadata?.labels ?? {}) }
  return {
    namespaceLabels,
    ...(networkPolicies ? { networkPolicies } : {}),
    ...(resourceQuotas ? { resourceQuotas } : {}),
    ...(mutatingWebhooks ? { mutatingWebhooks } : {}),
    ...(roles ? { roles } : {}),
    ...(roleBindings ? { roleBindings } : {}),
    ...(clusterRoles ? { clusterRoles } : {}),
    ...(clusterRoleBindings ? { clusterRoleBindings } : {}),
    ...(priorityClasses ? { priorityClasses } : {}),
    ...(coreDns ? { coreDns } : {}),
  }
}

// ── label selectors ──────────────────────────────────────────────────────────

/**
 * Does a full label selector (matchLabels + matchExpressions) select these labels?
 * An empty selector selects everything, as the API server reads it for a
 * NetworkPolicy podSelector and a webhook namespaceSelector.
 */
export function selectorMatches(selector: FullLabelSelector | undefined, labels: Record<string, string>): boolean {
  if (!selector) return true
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) if (labels[k] !== v) return false
  for (const req of selector.matchExpressions ?? []) {
    const key = req.key ?? ''
    const has = Object.prototype.hasOwnProperty.call(labels, key)
    const values = req.values ?? []
    switch (req.operator) {
      case 'In':
        if (!has || !values.includes(labels[key]!)) return false
        break
      case 'NotIn':
        if (has && values.includes(labels[key]!)) return false
        break
      case 'Exists':
        if (!has) return false
        break
      case 'DoesNotExist':
        if (has) return false
        break
      default:
        return false
    }
  }
  return true
}

// A workload's pod label sets: its running pods' labels, or with none running,
// its own selector's labels (what its pods will carry).
function workloadLabelSets(deployment: Deployment, pods: Pod[]): Array<Record<string, string>> {
  const own = deployment.spec?.selector?.matchLabels ?? {}
  if (Object.keys(own).length === 0) return []
  const running = pods
    .map((p) => p.metadata?.labels ?? {})
    .filter((labels) => Object.entries(own).every(([k, v]) => labels[k] === v))
  return running.length > 0 ? running : [own]
}

function workloadsMatching(selector: FullLabelSelector | undefined, deployments: Deployment[], pods: Pod[]): string[] {
  const out = new Set<string>()
  for (const d of deployments) {
    const name = d.metadata?.name
    if (typeof name !== 'string' || name.length === 0) continue
    if (workloadLabelSets(d, pods).some((labels) => selectorMatches(selector, labels))) out.add(name)
  }
  return [...out].sort()
}

// ── signals ──────────────────────────────────────────────────────────────────

// The Corefile is read whole up to this many characters; a real one is a few
// hundred bytes, so a cut means something unusual and is marked.
const COREFILE_MAX_CHARS = 16 * 1024

function specSignal(kind: string, name: string, namespace: string | undefined, spec: Record<string, unknown>): ObservedSignal {
  return {
    targetKind: K8S_OBJECT_TARGET_KIND,
    targetName: packK8sObjectName(kind, name),
    callCount: 0,
    errorCount: 0,
    lastObservedIso: new Date().toISOString(),
    infraSpec: { ...(namespace ? { namespace } : {}), spec },
  }
}

/** The full set of one kind's objects a read returned, for retiring the rest. */
export function inventorySignal(kind: string, namespace: string | undefined, present: string[]): ObservedSignal {
  return {
    targetKind: K8S_OBJECT_TARGET_KIND,
    targetName: packK8sObjectName(kind, '*'),
    callCount: 0,
    errorCount: 0,
    lastObservedIso: new Date().toISOString(),
    infraInventory: { kind, provider: 'kubernetes', ...(namespace ? { namespace } : {}), present: [...present].sort() },
  }
}

function named<T extends { metadata?: ObjectMeta }>(items: T[]): Array<T & { metadata: ObjectMeta & { name: string } }> {
  return items.filter(
    (i): i is T & { metadata: ObjectMeta & { name: string } } =>
      typeof i.metadata?.name === 'string' && i.metadata.name.length > 0,
  )
}

function inScopeSubjects(binding: RoleBinding, namespace: string, bindingNamespace: string | undefined): RoleSubject[] {
  return (binding.subjects ?? []).filter((s) => {
    if (s.kind === 'ServiceAccount') return (s.namespace ?? bindingNamespace) === namespace
    if (s.kind === 'Group') return s.name === 'system:serviceaccounts' || s.name === `system:serviceaccounts:${namespace}`
    return false
  })
}

function serviceAccountsOf(subjects: RoleSubject[]): string[] {
  return subjects.filter((s) => s.kind === 'ServiceAccount' && typeof s.name === 'string').map((s) => s.name!)
}

function rulesOf(role: Role): Array<Record<string, unknown>> {
  return (role.rules ?? []).map((r) => {
    const rule: Record<string, unknown> = {}
    if (r.apiGroups) rule['apiGroups'] = [...r.apiGroups]
    if (r.resources) rule['resources'] = [...r.resources]
    if (r.resourceNames) rule['resourceNames'] = [...r.resourceNames]
    if (r.verbs) rule['verbs'] = [...r.verbs]
    if (r.nonResourceURLs) rule['nonResourceURLs'] = [...r.nonResourceURLs]
    return rule
  })
}

function webhookSpec(w: MutatingWebhook): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (w.name) out['name'] = w.name
  if (w.failurePolicy) out['failurePolicy'] = w.failurePolicy
  if (w.sideEffects) out['sideEffects'] = w.sideEffects
  if (w.reinvocationPolicy) out['reinvocationPolicy'] = w.reinvocationPolicy
  if (typeof w.timeoutSeconds === 'number') out['timeoutSeconds'] = w.timeoutSeconds
  if (w.matchPolicy) out['matchPolicy'] = w.matchPolicy
  if (w.namespaceSelector) out['namespaceSelector'] = w.namespaceSelector
  if (w.objectSelector) out['objectSelector'] = w.objectSelector
  if (w.rules) out['rules'] = w.rules
  // The backend it calls, never the CA bundle.
  const svc = w.clientConfig?.service
  if (svc) out['service'] = { ...svc }
  else if (w.clientConfig?.url) out['url'] = w.clientConfig.url
  return out
}

/**
 * The config objects one poll read, as InfraNode spec signals plus, for each
 * kind read in full, an inventory signal that clears the spec off a node whose
 * object is gone. A kind whose read failed contributes nothing.
 */
export function configObjectSignals(
  objects: K8sConfigObjects,
  namespace: string,
  deployments: Deployment[],
  pods: Pod[],
): ObservedSignal[] {
  const out: ObservedSignal[] = []

  if (objects.networkPolicies) {
    const items = named(objects.networkPolicies)
    for (const np of items) {
      const spec: Record<string, unknown> = {
        podSelector: np.spec?.podSelector ?? {},
        policyTypes: np.spec?.policyTypes ?? [],
        ingress: np.spec?.ingress ?? [],
        egress: np.spec?.egress ?? [],
        selectsWorkloads: workloadsMatching(np.spec?.podSelector, deployments, pods),
      }
      out.push(specSignal('k8s-networkpolicy', np.metadata.name, namespace, spec))
    }
    out.push(inventorySignal('k8s-networkpolicy', namespace, items.map((i) => i.metadata.name)))
  }

  if (objects.resourceQuotas) {
    const items = named(objects.resourceQuotas)
    for (const q of items) {
      const spec: Record<string, unknown> = { hard: { ...(q.spec?.hard ?? q.status?.hard ?? {}) } }
      if (q.status?.used) spec['used'] = { ...q.status.used }
      if (q.spec?.scopes) spec['scopes'] = [...q.spec.scopes]
      out.push(specSignal('k8s-resourcequota', q.metadata.name, namespace, spec))
    }
    out.push(inventorySignal('k8s-resourcequota', namespace, items.map((i) => i.metadata.name)))
  }

  if (objects.mutatingWebhooks) {
    const items = named(objects.mutatingWebhooks)
    const labels = objects.namespaceLabels ?? { 'kubernetes.io/metadata.name': namespace }
    for (const mwc of items) {
      // Only the webhooks whose namespaceSelector takes this namespace in.
      const applies = (mwc.webhooks ?? []).filter((w) => selectorMatches(w.namespaceSelector, labels))
      if (applies.length === 0) continue
      out.push(specSignal('k8s-mutatingwebhookconfiguration', mwc.metadata.name, undefined, { webhooks: applies.map(webhookSpec) }))
    }
    // Cluster-scoped: cleared only when the object is gone from the cluster.
    out.push(inventorySignal('k8s-mutatingwebhookconfiguration', undefined, items.map((i) => i.metadata.name)))
  }

  // RBAC: the namespace's Roles and RoleBindings, and the ClusterRoleBindings
  // that name one of its service accounts, with the ClusterRoles any of those
  // bindings grant.
  const clusterRoleRefs = new Map<string, Set<string>>()
  const roleBoundTo = new Map<string, Set<string>>()
  const noteRef = (ref: RoleBinding['roleRef'], sas: string[]) => {
    if (!ref?.name) return
    const target = ref.kind === 'ClusterRole' ? clusterRoleRefs : ref.kind === 'Role' ? roleBoundTo : undefined
    if (!target) return
    const set = target.get(ref.name) ?? new Set<string>()
    for (const sa of sas) set.add(sa)
    target.set(ref.name, set)
  }
  if (objects.roleBindings) {
    const items = named(objects.roleBindings)
    for (const rb of items) {
      const subjects = rb.subjects ?? []
      noteRef(rb.roleRef, serviceAccountsOf(inScopeSubjects(rb, namespace, namespace)))
      out.push(
        specSignal('k8s-rolebinding', rb.metadata.name, namespace, {
          roleRef: { ...(rb.roleRef ?? {}) },
          subjects: subjects.map((s) => ({ ...s })),
        }),
      )
    }
    out.push(inventorySignal('k8s-rolebinding', namespace, items.map((i) => i.metadata.name)))
  }
  if (objects.clusterRoleBindings) {
    const items = named(objects.clusterRoleBindings)
    for (const crb of items) {
      const subjects = inScopeSubjects(crb, namespace, undefined)
      if (subjects.length === 0) continue
      noteRef(crb.roleRef, serviceAccountsOf(subjects))
      out.push(
        specSignal('k8s-clusterrolebinding', crb.metadata.name, undefined, {
          roleRef: { ...(crb.roleRef ?? {}) },
          subjects: subjects.map((s) => ({ ...s })),
        }),
      )
    }
    out.push(inventorySignal('k8s-clusterrolebinding', undefined, items.map((i) => i.metadata.name)))
  }
  if (objects.roles) {
    const items = named(objects.roles)
    for (const r of items) {
      out.push(
        specSignal('k8s-role', r.metadata.name, namespace, {
          rules: rulesOf(r),
          boundServiceAccounts: [...(roleBoundTo.get(r.metadata.name) ?? [])].sort(),
        }),
      )
    }
    out.push(inventorySignal('k8s-role', namespace, items.map((i) => i.metadata.name)))
  }
  if (objects.clusterRoles) {
    const items = named(objects.clusterRoles)
    for (const r of items) {
      const bound = clusterRoleRefs.get(r.metadata.name)
      if (!bound) continue
      out.push(
        specSignal('k8s-clusterrole', r.metadata.name, undefined, {
          rules: rulesOf(r),
          boundServiceAccounts: [...bound].sort(),
        }),
      )
    }
    out.push(inventorySignal('k8s-clusterrole', undefined, items.map((i) => i.metadata.name)))
  }

  // PriorityClasses (#1487): the ones the namespace's workloads name, and any
  // global default, which a pod naming none gets at admission.
  if (objects.priorityClasses) {
    const items = named(objects.priorityClasses)
    const usedBy = new Map<string, string[]>()
    for (const d of deployments) {
      const pc = d.spec?.template?.spec?.priorityClassName
      const name = d.metadata?.name
      if (typeof pc !== 'string' || pc.length === 0 || typeof name !== 'string') continue
      usedBy.set(pc, [...(usedBy.get(pc) ?? []), name])
    }
    for (const pc of items) {
      const workloads = usedBy.get(pc.metadata.name)
      if (!workloads && pc.globalDefault !== true) continue
      const spec: Record<string, unknown> = {
        globalDefault: pc.globalDefault === true,
        usedByWorkloads: [...(workloads ?? [])].sort(),
      }
      if (typeof pc.value === 'number') spec['value'] = pc.value
      if (pc.preemptionPolicy) spec['preemptionPolicy'] = pc.preemptionPolicy
      out.push(specSignal('k8s-priorityclass', pc.metadata.name, undefined, spec))
    }
    out.push(inventorySignal('k8s-priorityclass', undefined, items.map((i) => i.metadata.name)))
  }

  if (objects.coreDns) {
    const corefile = objects.coreDns.data?.['Corefile']
    if (typeof corefile === 'string') {
      const spec: Record<string, unknown> = { corefile: corefile.slice(0, COREFILE_MAX_CHARS) }
      if (corefile.length > COREFILE_MAX_CHARS) spec['corefileTruncated'] = true
      out.push(specSignal('k8s-configmap', 'coredns', 'kube-system', spec))
    }
  }

  return out
}
