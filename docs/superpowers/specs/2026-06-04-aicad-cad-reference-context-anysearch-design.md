# AI-CAD CAD Reference Context and AnySearch Design

## Goal

AI-CAD should keep useful CAD-specific references available even when the user disables general web search. General web search should use AnySearch, while step.parts and the local excellent CadQuery library remain CAD-specific inputs to planning.

## Behavior

- `webSearch.enabled=false` disables only general web search providers.
- CAD-specific context still runs by default:
  - step.parts candidate discovery from the current message and recent conversation.
  - local excellent CadQuery example matching from the human-rated library.
- step.parts candidates are reference records for the planner. The later assembly build still downloads and verifies the chosen STEP file through the existing standard-part hydration path.
- If step.parts lookup fails during reference discovery, the planner receives a clear warning, not fake dimensions.
- Local CadQuery examples are modeling references only. They must not override user dimensions, part count, orientation, or intent.
- General web search defaults to `anysearch`. Tavily remains available when explicitly configured, and China providers remain explicitly selectable.

## Architecture

- Add a focused `cad-reference-context.js` module for pure, testable context building.
- Keep `server.js` responsible for orchestration:
  - optionally run general web search based on UI setting.
  - always build CAD-specific context.
  - pass combined context to the planner prompt.
- Extend `prompt-contract.js` with explicit sections for standard part candidates and local CadQuery template matches.
- Add an AnySearch HTTP provider in `server.js`, using `POST https://api.anysearch.com/v1/search` and optional `ANYSEARCH_API_KEY`.

## Testing

- Unit-test step.parts candidate term extraction and local template ranking without network.
- Unit-test prompt text to ensure CAD-specific context has explicit planner instructions.
- Unit-test AnySearch response parsing through an injectable HTTP response helper.
- Run the existing full `npm run check` gate.
