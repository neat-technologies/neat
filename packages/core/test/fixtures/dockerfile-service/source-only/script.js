// A loose script with no Dockerfile and no manifest. Not a deployable unit —
// discovery must mint nothing for it.
function helper() {
  return 42
}

module.exports = { helper }
