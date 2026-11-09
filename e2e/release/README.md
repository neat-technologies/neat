# e2e/release — is main releasable?

Proves the **artifact**, not the source tree: packs every publishable package from the current build, installs the tarballs together into an empty directory the way a user's `npm i` would (install scripts on, so tree-sitter and other native modules build for that Node), and runs [`e2e/phase0`](../phase0/README.md) against the installed `neat` / `neat-mcp`. Nothing is published.

```bash
npx turbo build --concurrency=1
./e2e/release/run.sh                     # with the node on PATH
NODE_DIRS="$HOME/node-v20.0.0-darwin-arm64/bin $HOME/node-v22.12.0-darwin-arm64/bin" ./e2e/release/run.sh
```

Each `NODE_DIRS` entry is a Node `bin` directory (its own `node` and `npm`), from a nodejs.org tarball, nvm, or Homebrew. A version fails on a non-zero install, any `EBADENGINE`, or any failing phase0 case. The exit code is the number of failing versions; logs stay in the printed directory.

Run it before tagging a release: it covers what `publish.yml`'s post-publish umbrella smoke can only find after the versions are already on npm.
