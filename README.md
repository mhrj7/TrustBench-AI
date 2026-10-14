# TrustBench-AI

TrustBench-AI is a local-first evaluation and enforcement project for tool-using AI agents. The core release uses synthetic data and mock tools to compare bounded baseline and defended configurations without real external side effects.

This is an [eve](https://eve.dev) agent bootstrapped with [`eve init`](https://eve.dev/docs/reference/cli#eve-init).

## Getting started

The project is designed to live at `/Volumes/MHRJ/TrustBench-AI`. Install the locked dependencies and run the credential-free verification suite:

```bash
cp .env.example .env
npm ci
npm run verify
```

The environment and clean-install procedure are documented in [`docs/development-environment.md`](docs/development-environment.md). Project storage requirements are in [`docs/storage-policy.md`](docs/storage-policy.md).

After verification, start the development server with `npm run dev`. A provider-backed interactive session may require credentials; the TB-003 smoke fixture does not.

The development TUI opens an interactive session where you can send messages to your agent.

Start by editing `agent/instructions.md` to define the agent's identity, purpose, tone, and response guidelines. Configure its model and runtime behavior in `agent/agent.ts`.

Add capabilities under `agent/`, including tools, connections, channels, skills, subagents, and schedules. eve reloads your changes as you work.

## Learn more

To learn more about eve, explore these resources:

- [eve documentation](https://eve.dev/docs) — learn about eve's features and authoring APIs.
- [Build an Agent tutorial](https://eve.dev/docs/tutorial/first-agent) — build and deploy an agent step by step.
- [eve on GitHub](https://github.com/vercel/eve) — view the source and contribute.

## Deploy on Vercel

Deploy your agent to [Vercel](https://vercel.com) from the project root:

```bash
eve deploy
```

`eve deploy` links a Vercel project if needed and deploys the agent to production. See the [eve deployment documentation](https://eve.dev/docs/guides/deployment/vercel) for authentication, environment variables, and deployment options.
