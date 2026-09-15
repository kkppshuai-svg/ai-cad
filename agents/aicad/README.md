# AI-CAD Agent Package

This directory packages the AI-CAD repository as a reusable local agent. The application itself lives at the repository root; this package records the agent metadata, operating rules, and environment checks needed to run it consistently on another machine.

## Install

Clone the repository, then from the repo root:

```bash
scripts/setup_cadquery_env.sh
npm run check
```

Optional local install into a Codex skills directory:

```bash
mkdir -p "$HOME/.codex/skills/aicad"
cp agents/aicad/SKILL.md "$HOME/.codex/skills/aicad/SKILL.md"
cp -R agents/aicad/references "$HOME/.codex/skills/aicad/references"
cp -R agents/aicad/scripts "$HOME/.codex/skills/aicad/scripts"
```

## Run

```bash
npm start
```

Open `http://127.0.0.1:3101` unless `PORT` is set.

## Check

```bash
agents/aicad/scripts/check_agent_env.sh
npm run check
```

## Notes

Generated CAD outputs are intentionally ignored by git. Share completed models through exported ZIP/TAR artifacts, not by committing `assemblies/`.
