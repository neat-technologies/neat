// Ambient declarations for the cytoscape extensions, which ship no @types.
// Both are registered onto cytoscape via `cytoscape.use(ext)`.

declare module 'cytoscape-elk' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ext: any
  export default ext
}

declare module 'cytoscape-expand-collapse' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ext: any
  export default ext
}
