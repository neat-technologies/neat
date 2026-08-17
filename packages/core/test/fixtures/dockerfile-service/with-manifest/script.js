// This dir has a package.json AND a Dockerfile. The manifest owns the dir, so it
// discovers as `fixture-with-manifest` (from package.json), never double-minted
// by the Dockerfile path.
function serve() {
  return 'ok'
}

module.exports = { serve }
