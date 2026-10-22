---
name: interactive-html-report
description: >-
  Builds institutional-grade, publication-quality interactive HTML research reports,
  data intelligence dashboards, and strategic business analysis documents.
  Use when asked to generate, write, design, or deliver rich HTML reports, data analysis presentations,
  or decision-making dashboards. Enforces an editorial aesthetic (paper theme, Spectral/IBM Plex typography,
  Factbars, Finding cards) combined with zero-dependency vanilla JS dynamic interactions (client-side
  table multi-column sorting, real-time search/pills filtering, interactive SVG tooltips, metric tab toggles,
  chart-to-table cross-highlighting, and code copy-to-clipboard).
---

# Interactive HTML Report Architect

This skill provides the comprehensive methodology, editorial design system, and code implementations for building **institutional-grade, publication-quality, self-contained interactive HTML research reports**.

When users request data analysis, technical investigations, market research, or system strategy proposals, this skill enables the agent to deliver **single-file, zero-dependency `.html` artifacts** that combine the typographic dignity of *The Economist / Financial Times* with the fluid interactivity of modern BI dashboards (*Databricks / Observable*).

---

## 1. Core Principles: The Triad of Excellence

Every delivered report must achieve three non-negotiable qualities:

```
           [ 1. Editorial Aesthetic ]
         Paper palette, Serif headings,
           Factbars & Finding Cards
                     ▲
                    / \
                   /   \
                  /     \
                 /       \
[ 2. Zero-Dependency ] ◄---► [ 3. Tactile Interactivity ]
 Single-file HTML/CSS/JS,      Sortable tables, Search filters,
  offline-first, no frameworks   SVG Tooltips, Cross-highlighting
```

1. **Editorial Design System**: Avoid generic "Bootstrap/Tailwind default" looks. Use warm paper backgrounds (`#F2EFE7`), layered typography (`Spectral` serif + `IBM Plex Sans` + `IBM Plex Mono`), grid factbars, and formal finding cards.
2. **Tactile Interactivity**: Static tables and flat SVG images are insufficient. Reports must feel alive—tables must be sortable and filterable in real time; chart elements must have tooltip inspection on hover; code blocks must have one-click copy.
3. **Zero-Dependency Self-Containment**: Never import heavy runtime libraries (React, Vue, jQuery, Chart.js, Lodash). Write clean, defensive **Vanilla JavaScript** directly inside `<script>` tags. The output must be a single `.html` file that boots instantly in any browser when double-clicked, even offline.

---

## 2. Standard Document Architecture

A standard interactive report consists of 8 modular sections:

| Order | Section ID | Visual Component | Purpose & Content |
|---|---|---|---|
| **0** | `<header>` | **Masthead + Factbar** | Breadcrumbs, serif title, subtitle, and an 8-cell key metric summary grid. |
| **1** | `#learn` | **Methodology / Trap Alert** | Collapsible `<details class="learn">` educating readers on data caveats, traps, and formulas. |
| **2** | `#summary` | **Executive Summary** | 3-bullet core takeaways, high-level policy decision table, and strategic ROI callouts (`.note.event`). |
| **3** | `#analytics` | **Macro Landscape & Cost** | Comprehensive data table with dynamic sorting and interactive SVG cost ladder charts. |
| **4** | `#deep-dive` | **Attribution / Hypothesis Proof** | Granular data breakdown, proving/disproving business assumptions with payload-level evidence. |
| **5** | `#anomalies` | **Outlier Investigation** | Systematic post-mortem on anomalies, edge cases, and noise mechanisms. |
| **6** | `#findings` | **Finding Cards (`.finding`)** | Strict `F-01` to `F-04` claim-and-rebuttal cards challenging naive assumptions. |
| **7** | `#actions` | **Strategic Roadmap & SQL** | Concrete execution checklist, instrumentation patch suggestions, and reproducible SQL queries. |

---

## 3. High-Priority Interactive Components

When building the report, implement these essential Vanilla JS interactions (see [Interactive Components Reference](./references/interactive-components.md) for ready-to-use code):

### A. Sortable Data Tables (`makeSortable(table)`)
- Click on any column header (`<th>`) to toggle ascending/descending sorting.
- Automatically handles: Numbers (`42.5`), Currencies (`¥1,800`), Percentages (`21.6%`), Dates, and Japanese text.
- Renders elegant direction indicators (`▲`, `▼`, `⇅`).

### B. Real-Time Table Filter & Tag Pills (`initTableFilter(tableId, inputId, pillContainerId)`)
- Live search input: Filter rows instantly on `input` events with debouncing.
- Category pills (e.g. `[全部] [二手] [一手] [异常]`) for instant subset slicing.
- Displays matching row counts (`显示 11 / 11 条记录`).

### C. SVG Chart Tooltip Engine (`initSvgTooltips(svgId)`)
- Native floating HTML tooltip positioned smoothly on mousemove over SVG `<rect>`, `<circle>`, or `<path>`.
- Displays contextual metadata: Exact counts, percentage shares, sample sizes, and unit economics.
- Enhances charts without external D3 or Chart.js dependencies.

### D. Chart-to-Table Cross-Highlighting
- Hovering over a chart bar automatically highlights the corresponding row in the data table below, and vice versa.

### E. One-Click Copy for SQL & Code Blocks
- Floating "复制" button on `<pre><code>` blocks.
- Provides immediate tactile visual feedback (`"已复制 ✓"`) for 1.5 seconds.

---

## 4. Design System & Style Guide

Detailed CSS variables, typographic hierarchies, color palettes, and container classes are documented in:
👉 **[Editorial Design System Reference](./references/editorial-design-system.md)**

Quick Palette Cheat-Sheet:
```css
:root {
  --paper:   #F2EFE7; /* Background page canvas */
  --surface: #FBFAF6; /* Elevated cards, plot canvas, table wrap */
  --sunk:    #EAE6DA; /* Table headers, blockquote backgrounds */
  --ink:     #1B2422; /* Primary high-contrast text */
  --ink-2:   #4A5754; /* Body copy & explanations */
  --ink-3:   #7C8884; /* Captions, timestamps, column labels */
  --rule:    #D9D3C5; /* Subtle borders & grid lines */
  --rule-2:  #C4BCA9; /* Accent borders */
  --risk:    #2E6F66; /* Primary brand accent (forest teal) */
  --event:   #C0522F; /* Alert / critical findings (terracotta orange) */
  --warn:    #B4832B; /* Cautionary / intermediate state (amber gold) */
  --shadow:  0 1px 0 rgba(27,36,34,.06), 0 8px 24px -18px rgba(27,36,34,.5);
}
```

---

## 5. Complete Boilerplate Template

To jumpstart document creation, inspect and adapt the complete single-file boilerplate:
👉 **[HTML Boilerplate Template](./references/boilerplate.html)**

---

## 6. Execution Workflow Checklist

When tasked with generating a data or strategy report:
1. **Analyze & Aggregate Data**: Extract clean metrics, percentages, medians, and outlier lists.
2. **Draft Narrative Structure**: Formulate 3 core findings and 1 executive summary decision table.
3. **Assemble HTML Artifact**:
   - Paste the Google Fonts link and core `:root` CSS variables.
   - Construct the masthead and 8-cell Factbar.
   - Write the collapsible `#learn` methodology guide.
   - Embed data tables with semantic classes (`.tbl-wrap`, `<table>`, `.tag-*`).
   - Draw inline SVG charts with accessible labels and `data-*` attributes for tooltips.
   - Inject the self-contained `<script>` block containing sorting, filtering, tooltips, and copy-buttons.
4. **Deliver Single File**: Save to target location (`.html` and companion `.md`) and confirm dual-pane or desktop readiness.
