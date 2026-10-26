# Rialto's Claude Code mods

Mods for Claude Code, made with the plugin-authoring skill.

## Mods

### Orbit

Mission Control for Claude Code.

- **Usage card** above the prompt: 7-day and 5-hour limits, a WARM/COLD prompt-cache timer, idle time, tokens in cache, and what your next message would cost on Opus, Sonnet and Haiku. It warns you before a big cache goes cold and suggests `/compact` or `/clear` when it has. Minimize it with the **—** in its corner.
- **Mission strip** while agents or tasks run: progress pill, percent, agent count, cost, tokens and time.
- **Agents sidebar** (`/orbit`): Cost / Tokens / Time, then Running, Finished and Planned, one card per agent with a pixel mascot whose hat shows its effort (light, medium, careful, heavy), model, step, context %, tokens, cost and a progress bar.
- A toast and macOS's Glass chime when every agent and task is done.

Costs are shown in euro, estimated from Anthropic's list prices at a fixed rate (default 0.92 per dollar).

Settings (in the plugin's config): `eurRate`, `playSound`.

Commands: `/orbit` opens the sidebar, `/orbit usage` minimizes or expands the usage card.

## Install

This repository is private: you need read access on GitHub and a git credential for github.com on your machine (`gh auth login`, then `gh auth setup-git`).

At the prompt of a Claude Code terminal session:

```
/plugin install orbit --marketplace RialtoDaph/mods-
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install orbit --marketplace RialtoDaph/mods-
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `RialtoDaph/mods-`, then **Add plugin**.
