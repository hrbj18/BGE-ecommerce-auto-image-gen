# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. Record durable UI contracts in `docs/handoff/WEB_APP.md`; keep this nested file limited to short frontend-only instructions.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable UI Decisions

- The left column is for creating tasks: upload reference images, enter product name, write selling points, run AI expansion, and start generation.
- The right column is for feedback and retrieval: current result/preview at the top, unified historical tasks directly below it.
- Do not split "recent tasks" and "recent completed" into separate homepage sections. Use one "历史任务/历史记录" surface that combines status, output entry, generation time, prompt import, and deletion.
