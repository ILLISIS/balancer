# Balancer

Moves empty tiles between Clusterio hosts with their saves, fails over the tiles of a host that's gone, and fences a host cut off from the controller. Every host must load it.

## Requirements

- Clusterio built from source, master at commit `4c0c89c` or later. 2.0.0-alpha.27, the latest release, lacks APIs this uses, and before `4c0c89c` the plugins' web pages don't load.
- Node 22 or later, and pnpm at the version in Clusterio's `packageManager`.
- Universal Edges v2, cloned next to it (`external_plugins/universal_edges`).

## Install

In a Clusterio checkout:

```sh
git clone -b v2 https://github.com/clusterio/universal_edges.git external_plugins/universal_edges
git clone https://github.com/ILLISIS/balancer.git external_plugins/balancer
pnpm install
pnpm build
pnpm run -r --if-present prepare
```

`prepare` compiles the plugin and bundles its web page. Add the plugin to the controller's plugin list with `npx clusteriocontroller plugin add <path to external_plugins/balancer>` and to each host's with `npx clusteriohost plugin add <that path>`.

In the plugin list, put balancer before gridworld.

## Test and lint

Run these from inside the Clusterio checkout, where ESLint is installed:

```sh
pnpm --filter balancer run test   # unit tests; run prepare first
pnpm --filter balancer run lint   # ESLint with Clusterio's rules
```

Multi-instance end-to-end tests run from the clusterio-v2 integration repo, which isn't public. The design documents that code comments cite by section (§) live there too.

## Licence

Blue Oak Model License 1.0.0, in `LICENSE.md`.
