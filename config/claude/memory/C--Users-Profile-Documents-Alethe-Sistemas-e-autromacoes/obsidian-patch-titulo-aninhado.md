---
name: obsidian-patch-titulo-aninhado
description: The obsidian MCP patch_content works on any heading level when the target is the full heading path joined by "::"; replace drops the "---" before "# Notas relacionadas"
metadata:
  type: feedback
---

`mcp__obsidian__obsidian_patch_content` with `target_type: heading` accepts headings of any level if the target is the full path from the top heading, joined by `::` (e.g. `Alethe::Relacionados`, `Alethe Orchestra - Agente criativo::Próximos passos`; a note without H1 starts at its first H2, e.g. `Prompt — <tema>`). A bare H2 title without the path fails. `target_type: frontmatter` also works (e.g. `atualizado`). `replace` on the section right above `# Notas relacionadas` deletes the `---` separator: re-append `---` with a blank line before it (otherwise it becomes a setext heading underline).

**Why:** The vault notes claimed patch only accepts H1; verified otherwise on 2026-10-04 while documenting Alethe Orchestra. Lets agents edit a hub's "Relacionados" or a section in place instead of appending at the end or touching files on disk.

**Where it is recorded:** technical MCP learnings go to the technical note "Ferramentas/Inteligência Artificial/IA de texto/Claude/Claude + Obsidian - Configuração do MCP.md" (section 7). Never edit the owner's rules note "Claude + Obsidian - Preferências e regras de uso" (orchestrator's instruction, 2026-10-04); items 9 and 10 added there that night stay until the owner decides.

**How to apply:** For in-place edits in the vault, use the full heading path; after a section `replace`, check the note tail with a read-only `tail` on `G:\Meu Drive\Anotações\TODO\...` and restore the `---`. Related: [[padrao-de-notas-obsidian]], [[consultar-obsidian-antes]].

Gotchas seen the same night:
- In a shared, append-only log note (e.g. `Alethe Orchestra/<date> Orchestra.md`), never patch-append under your own heading: blocks other agents append later become its subsections, so the text lands far below, inside someone else's area. Append at the end of the file instead.
- On a very large note (~360 KB) the MCP patch times out (3 s read timeout) and nothing is written; check the file before retrying. The Local REST API PATCH with a longer timeout took 145 ms.
- A `replace` whose content is already inside the section is refused with `content-already-preexists-in-target` (40080); send the header `Apply-If-Content-Preexists: true`.
