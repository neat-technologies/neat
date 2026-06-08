# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately, not through public issues.

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/NEAT-Technologies/Neat/security/advisories/new) — opens a private advisory only the maintainers can see.
- **Email:** deniz@neat.is

Include the affected version, a description of the issue, and steps to reproduce if you have them. We aim to acknowledge a report within 72 hours and to keep you updated as we work on a fix.

Please give us a reasonable window to release a fix before any public disclosure. We're grateful for responsible reports and will credit you in the advisory unless you'd prefer to stay anonymous.

## Supported versions

NEAT ships on a rolling `latest` tag on npm. Security fixes land on the current `latest` line; we don't backport to older patch releases. Run the latest `neat.is` to stay covered.

## Handling secrets

NEAT records the *existence* of config files (`.env`, `.env.local`) as `ConfigNode`s — it never reads or stores their contents into the graph snapshot. The `NEAT_AUTH_TOKEN` gates every public interface; the daemon refuses to bind a non-loopback address without one. See the [README](./README.md#run-neat-on-a-server) for the token model.
