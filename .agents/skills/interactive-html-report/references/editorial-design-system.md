# Editorial Design System Reference

This document defines the exact CSS design tokens, typographic scales, visual elements, and structural classes used in the institutional-grade interactive HTML report architecture.

---

## 1. CSS Custom Properties (`:root`)

```css
:root {
  /* Surface & Canvas Palette */
  --paper:          #F2EFE7; /* Background canvas */
  --surface:        #FBFAF6; /* Elevated card surface, table background, SVG canvas */
  --sunk:           #EAE6DA; /* Recessed backgrounds, table headers, code blocks */
  
  /* Ink Typography Palette */
  --ink:            #1B2422; /* Primary headline and high-contrast text */
  --ink-2:          #4A5754; /* Body copy and explanatory prose */
  --ink-3:          #7C8884; /* Captions, timestamps, table metadata */
  
  /* Structural Rules & Borders */
  --rule:           #D9D3C5; /* Default 1px structural separator */
  --rule-2:         #C4BCA9; /* Emphasized border or divider */
  
  /* Semantic Accents & Statuses */
  --risk:           #2E6F66; /* Forest teal: Primary brand, verified/exact match, healthy */
  --event:          #C0522F; /* Terracotta orange: Critical alert, confirmed finding, anomaly */
  --warn:           #B4832B; /* Amber gold: Caution, intermediate state, threshold warning */
  --censor:         #9AA79F; /* Sage grey: Dimmed, dismissed, pending */
  --accent-blue:    #2E6F9E; /* Slate blue: Secondary dimensional grouping */
  --accent-purple:  #7B5EA7; /* Muted violet: Alternative category */
  
  /* Elevation Shadows */
  --shadow:         0 1px 0 rgba(27,36,34,.06), 0 8px 24px -18px rgba(27,36,34,.5);
}
```

---

## 2. Typography Stack & Scale

Always import Google Fonts in the `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com/">
<link rel="preconnect" href="https://fonts.gstatic.com/" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Noto+Sans+SC:wght@400;500;700&family=Spectral:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
```

### Typographic Hierarchy Rules:
1. **Headings (`h1`, `h2`, `h3`)**: Must use **`Spectral, Georgia, "Songti SC", serif`**. This conveys authoritative, scholarly dignity.
2. **Body Text (`p`, `li`, `td`)**: Must use **`"IBM Plex Sans", -apple-system, "Noto Sans SC", sans-serif`**, `font-size: 16px`, `line-height: 1.78`.
3. **Data Columns, Metrics & Code**: Must use **`"IBM Plex Mono", ui-monospace, monospace`** with `font-variant-numeric: tabular-nums`.

---

## 3. Structural Components

### A. Masthead & 8-Cell Factbar Grid
The top header provides instant executive metrics:
```html
<header>
  <div class="wrap masthead">
    <div class="crumb eyebrow">
      <a href="#">← System Architecture</a>
      <span>Domain Analysis</span>
    </div>
    <div class="title-block">
      <h1>Report Main Title</h1>
      <p class="subtitle">Descriptive, engaging subtitle summarizing key quantitative findings.</p>
    </div>
    <dl class="factbar">
      <div><dt>Metric 1</dt><dd>59 items</dd></div>
      <div><dt>Metric 2</dt><dd>2,246 reqs</dd></div>
      <div><dt>Metric 3</dt><dd>15 confirmed</dd></div>
      <div><dt>Metric 4</dt><dd>3.52 ×</dd></div>
      <!-- Repeat up to 8 metrics -->
    </dl>
  </div>
</header>
```

### B. Collapsible Methodology Section (`#learn`)
Must be placed immediately below the header to educate non-expert readers on formulas, traps, and SQL replication:
```html
<section id="learn">
  <div class="sec-head">
    <p class="eyebrow">Methodology & Traps</p>
    <h2>Understanding Metrics and Reproducibility</h2>
  </div>
  <div class="stack">
    <details class="learn" open>
      <summary>01 · Metric Definition & Formula</summary>
      <div class="learn-body">
        <p>Explanatory text...</p>
        <pre><code>MDR = (P50_sec - P50_ref) / P50_ref</code></pre>
      </div>
    </details>
  </div>
</section>
```

### C. Finding Cards (`.finding`)
Used in analytical chapters to clearly state a counter-intuitive finding:
```html
<div class="finding">
  <div class="finding-n">F-01</div>
  <div>
    <div class="claim">The Core Counter-Intuitive Claim in Large Type</div>
    <div class="rebut">
      Detailed rebuttal and quantitative explanation proving why naive assumptions fail.
    </div>
  </div>
</div>
```

### D. Semantic Alert Boxes (`.note`)
- `.note`: Default teal accent for context and scope clarifications.
- `.note.event`: Terracotta orange for high-priority executive alerts or urgent conclusions.
- `.note.caution`: Amber gold for platform quirks, algorithmic warnings, or data caveats.

### E. Status Tags (`.tag`)
- `.tag-second`: Muted teal background for secondary market indicators.
- `.tag-primary`: Muted warm gold background for primary retail indicators.
- `.tag-action-yes`: Soft green badge for approved actions.
- `.tag-action-no`: Soft red badge for prohibited/disabled actions.
- `.tag-action-limit`: Soft amber badge for throttled/restricted policies.
