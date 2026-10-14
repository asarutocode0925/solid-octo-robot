# Clanker — Fly.io build

## Deploy

Run commands from this directory (the one containing `Dockerfile` and `fly.toml`).

```sh
# Confirm the browser entry point exists before deploying
ls client/main.js shared/game.js

# Run source syntax checks and shared game smoke tests
npm install --include=dev
npm run check

# Build and deploy to the configured Fly.io app
flyctl deploy -a curly-octo-invention
```

If the admin panel is needed, set a secret on Fly.io:

```sh
flyctl secrets set ADMIN_KEY='use-a-long-random-secret' -a curly-octo-invention
```

Do not commit `.env` or secrets. `ADMIN_KEY` is intentionally empty unless configured.

## Notes

- Vite and browser-only libraries are installed only in the build stage; the runtime image installs only production dependencies.
- The Docker build explicitly copies `client/`, `shared/`, and `tests/` so a deployment from the wrong directory fails early with a clear missing-path error.
- The Docker build runs `npm run check` before `vite build`.
- No `package-lock.json` was supplied, so the Dockerfile uses `npm install`, not `npm ci`. Generate and commit a lockfile in a network-enabled development environment for fully reproducible dependency versions.
- Validate the deployed URL and Fly logs after deployment; local static checks do not prove external deployment success.
