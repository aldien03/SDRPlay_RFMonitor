# RF Monitor Quiet Mission Board design QA

- Source visual truth: /home/sanco/.codex/generated_images/01a0250d-306a-7a92-82fe-c9d82db0aa7b/exec-4f3379e0-f66a-482f-a6f4-1e62c7faa78c.png
- Source dimensions: 1672 x 941 px, normalized to 1366 x 768 at artifacts/design-qa/rf-approved-concept-1366.jpg
- Final implementation captures: artifacts/design-qa/rf-monitor-focus-1366.png, artifacts/design-qa/rf-monitor-3x3-1366.png, artifacts/design-qa/rf-monitor-engineer-1366.png, and artifacts/design-qa/rf-monitor-mission-1920.png
- Same-input comparison: artifacts/design-qa/rf-monitor-comparison-1366.jpg
- Tested viewports: 1366 x 768 and 1920 x 1080 CSS px at deviceScaleFactor 1
- Tested state: simulation receiver online, GPS L1 / Galileo E1 / BeiDou B1C live for two minutes, wide surveys paused, 2x1 layout
- Browser method: local Playwright Chromium fallback previously approved by the user because the Browser plugin was unavailable

## Visual comparison

- Hierarchy matches the source: compact navy command bar, two dominant equal monitoring cards, five-item pinned shelf, and fixed four-part status footer.
- Card anatomy matches the source: service identity, physical coverage, plain status, live/survey mode, relative signal graph, aligned waterfall, frequency guides, and survey progress.
- Density matches the approved quiet mission-board direction at 1366 x 768. The graphs and pinned shelf remain visible without page scrolling.
- The 1920 x 1080 view expands the graph workspace while preserving the same hierarchy and keeps the page exactly within the viewport.
- Signal treatment is preserved: blue received activity, green usual-level reference, red anomaly segments when present, and aligned blue waterfall trails.

## Intentional state differences

- The reference says RSPdx. The local acceptance capture correctly says Simulation because QA used the built-in simulator.
- The live navigation card shows the actual 10 MHz receiver window (1570.420-1580.420 MHz), not only its 1575.42 MHz center. This is an intentional accuracy improvement from the approved implementation plan.
- Trace and waterfall shapes come from the live simulator, so they do not copy the static anomaly shown in the reference image.

## Interaction and layout evidence

- Make live confirmation clearly states that one 10 MHz window will be live for two minutes and the full survey will pause.
- Live focus activated the shared GPS L1 / Galileo E1 / BeiDou B1C feed; StarTrack showed Survey paused with a real countdown and preserved sweep percentage.
- Resume survey returned the receiver to priority scan.
- 3x3 rendered five compact spectrum cards plus four Add signal slots; waterfalls were intentionally hidden and Expand returned the selected card to 1x1.
- Engineer opened with the wide-survey analyzer first, followed by incident, display, and evidence sections in a normal scrolling drawer.
- The Engineer view exposed range, span, resolution, marker input, CSV export, receiver path, and navigation-integrity status.
- Both desktop viewports reported zero horizontal and vertical document overflow.
- Console and page-error listeners reported no errors or warnings.

## Findings and fixes

- [P1 fixed] Feed cards initially crashed because signalState was referenced before initialization.
- [P1 fixed] Local Make live requests were rejected by the backend same-origin guard because the Vite proxy changed the Host. The proxy now preserves the dashboard Host.
- [P2 fixed] The Engineer analyzer collapsed to a border because the scroll area's grid tracks shrank overflow-hidden children. The drawer now uses a non-shrinking vertical flex stack.
- [P2 fixed] Transient detecting state could survive long gaps between frequency-hop observations. Detection candidates now reset after an observation gap.
- No actionable P0, P1, or P2 issue remains.

## Verification

- npm run check: 15 test files, 70 tests passed.
- npm run build: production client, production server, and Sites handoff artifacts built successfully.
- npm run test:sites: 4 tests passed.
- Required outputs exist: dist/client/index.html, dist/server/index.js, and dist/.openai/hosting.json.
- The local preview remains running on port 4173 with the simulation backend on port 8081.
- The required view_image helper was unavailable because the workspace sandbox could not create its loopback namespace. Final reference, implementation, and combined comparison images were loaded directly as image inputs instead.

final result: passed
