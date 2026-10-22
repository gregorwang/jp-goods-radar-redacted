# Interactive Components Reference (Vanilla JS)

This guide provides drop-in, zero-dependency, production-grade Vanilla JavaScript patterns to transform static HTML reports into fluid, responsive, tactile analytical dashboards.

---

## 1. Smart Multi-Column Table Sorting (`makeSortable`)

Enables client-side instant sorting on any standard `<table>`. Handles numbers, currencies (`¥`, `$`), percentages (`%`), dates, and text strings.

### HTML Markup:
```html
<table class="sortable-table" id="myTable">
  <thead>
    <tr>
      <th data-sort="text">平台来源</th>
      <th data-sort="number">成功轮次</th>
      <th data-sort="number">请求数</th>
      <th data-sort="number">单品成本 (JPY)</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>mercari_jp</td><td>37</td><td>675</td><td>¥96.4</td></tr>
    <tr><td>yahoo_auctions_jp</td><td>43</td><td>947</td><td>¥157.8</td></tr>
  </tbody>
</table>
```

### CSS Styling:
```css
th[data-sort] {
  cursor: pointer;
  user-select: none;
  position: relative;
  padding-right: 20px !important;
}
th[data-sort]::after {
  content: " ⇅";
  opacity: 0.35;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.75rem;
}
th[data-sort].asc::after {
  content: " ▲";
  opacity: 0.9;
  color: var(--risk);
}
th[data-sort].desc::after {
  content: " ▼";
  opacity: 0.9;
  color: var(--event);
}
```

### JavaScript Implementation:
```javascript
function makeSortable(table) {
  const headers = table.querySelectorAll('th[data-sort]');
  headers.forEach((header, index) => {
    header.addEventListener('click', () => {
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const isAsc = header.classList.contains('asc');
      
      // Reset all other headers
      headers.forEach(h => h.classList.remove('asc', 'desc'));
      header.classList.toggle('asc', !isAsc);
      header.classList.toggle('desc', isAsc);
      
      const sortType = header.getAttribute('data-sort') || 'text';
      
      rows.sort((rowA, rowB) => {
        const cellA = rowA.children[index].innerText.trim();
        const cellB = rowB.children[index].innerText.trim();
        
        if (sortType === 'number') {
          // Strip currency symbols, commas, percent signs
          const numA = parseFloat(cellA.replace(/[^0-9.-]+/g, '')) || 0;
          const numB = parseFloat(cellB.replace(/[^0-9.-]+/g, '')) || 0;
          return isAsc ? numB - numA : numA - numB;
        } else {
          return isAsc 
            ? cellB.localeCompare(cellA, 'zh-CN') 
            : cellA.localeCompare(cellB, 'zh-CN');
        }
      });
      
      // Re-append sorted rows with minimal DOM repaint
      const fragment = document.createDocumentFragment();
      rows.forEach(r => fragment.appendChild(r));
      tbody.appendChild(fragment);
    });
  });
}
```

---

## 2. Real-Time Table Filter & Category Pills (`initTableFilter`)

Allows instant filtering via both a live text search bar and category buttons.

### HTML Markup:
```html
<div class="table-controls">
  <div class="filter-pills" id="pillsContainer">
    <button class="pill active" data-filter="all">全部来源 (11)</button>
    <button class="pill" data-filter="second">二手市场 (4)</button>
    <button class="pill" data-filter="primary">一手专卖 (7)</button>
    <button class="pill" data-filter="confirmed">仅看出货 (5)</button>
  </div>
  <div class="search-box">
    <input type="text" id="tableSearchInput" placeholder="输入平台、商品或状态过滤..." />
    <span class="count-badge" id="rowCountBadge">11 / 11 条</span>
  </div>
</div>
```

### CSS Styling:
```css
.table-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.pill {
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 4px 12px;
  font-family: "IBM Plex Sans", sans-serif;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--ink-2);
  cursor: pointer;
  border-radius: 20px;
  transition: all 0.15s ease;
}
.pill:hover { background: var(--sunk); color: var(--ink); }
.pill.active {
  background: var(--ink);
  color: var(--paper);
  border-color: var(--ink);
}
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 4px 10px;
  border-radius: 4px;
}
.search-box input {
  border: none;
  background: transparent;
  font-family: "IBM Plex Sans", sans-serif;
  font-size: 0.85rem;
  color: var(--ink);
  outline: none;
  width: 200px;
}
.count-badge {
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.72rem;
  color: var(--ink-3);
}
```

### JavaScript Implementation:
```javascript
function initTableFilter(tableId, searchInputId, pillsContainerId, countBadgeId) {
  const table = document.getElementById(tableId);
  const searchInput = document.getElementById(searchInputId);
  const pillsContainer = document.getElementById(pillsContainerId);
  const countBadge = document.getElementById(countBadgeId);
  
  if (!table) return;
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  let currentCategory = 'all';
  let currentSearch = '';
  
  function applyFilters() {
    let visibleCount = 0;
    
    rows.forEach(row => {
      const text = row.innerText.toLowerCase();
      const rowCategory = row.getAttribute('data-category') || '';
      
      const matchesSearch = currentSearch === '' || text.includes(currentSearch);
      const matchesPill = currentCategory === 'all' 
        || (currentCategory === 'confirmed' ? row.getAttribute('data-confirmed') === 'true' : rowCategory === currentCategory);
      
      if (matchesSearch && matchesPill) {
        row.style.display = '';
        visibleCount++;
      } else {
        row.style.display = 'none';
      }
    });
    
    if (countBadge) {
      countBadge.innerText = `${visibleCount} / ${rows.length} 条`;
    }
  }
  
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearch = e.target.value.trim().toLowerCase();
      applyFilters();
    });
  }
  
  if (pillsContainer) {
    pillsContainer.querySelectorAll('.pill').forEach(pill => {
      pill.addEventListener('click', () => {
        pillsContainer.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        currentCategory = pill.getAttribute('data-filter') || 'all';
        applyFilters();
      });
    });
  }
}
```

---

## 3. Interactive SVG Tooltips Engine (`initSvgTooltips`)

Renders a sleek, responsive hovering card over any inline SVG element containing `data-tooltip-*` attributes.

### HTML Markup (inside SVG):
```html
<rect 
  x="240" y="28" width="149" height="18" fill="#2E6F66" rx="2"
  class="chart-bar"
  data-source="mercari_jp"
  data-label="煤炉 (Mercari)"
  data-requests="675"
  data-items="7"
  data-cost="¥96.4 / 品"
  data-note="高木同学卫衣与A3原画绝对独占主力">
</rect>
```

### CSS Styling:
```css
.chart-tooltip {
  position: absolute;
  display: none;
  pointer-events: none;
  background: var(--ink);
  color: var(--surface);
  padding: 8px 12px;
  border-radius: 4px;
  font-family: "IBM Plex Sans", sans-serif;
  font-size: 0.8rem;
  line-height: 1.4;
  box-shadow: 0 4px 16px rgba(27,36,34, 0.25);
  z-index: 1000;
  max-width: 260px;
  border: 1px solid var(--rule-2);
}
.chart-tooltip .tt-title {
  font-weight: 600;
  font-family: "Spectral", serif;
  font-size: 0.95rem;
  margin-bottom: 4px;
  color: #FBFAF6;
  border-bottom: 1px solid rgba(255,255,255, 0.2);
  padding-bottom: 2px;
}
.chart-tooltip .tt-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.75rem;
}
.chart-bar {
  cursor: pointer;
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.chart-bar:hover {
  opacity: 1 !important;
  filter: brightness(1.15);
}
```

### JavaScript Implementation:
```javascript
function initSvgTooltips(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  
  let tooltip = document.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    document.body.appendChild(tooltip);
  }
  
  const elements = container.querySelectorAll('[data-label]');
  
  elements.forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      const title = el.getAttribute('data-label') || '';
      const requests = el.getAttribute('data-requests') || '';
      const items = el.getAttribute('data-items') || '';
      const cost = el.getAttribute('data-cost') || '';
      const note = el.getAttribute('data-note') || '';
      
      tooltip.innerHTML = `
        <div class="tt-title">${title}</div>
        ${requests ? `<div class="tt-row"><span>上游请求:</span><b>${requests} 次</b></div>` : ''}
        ${items ? `<div class="tt-row"><span>去重同款:</span><b>${items} 件</b></div>` : ''}
        ${cost ? `<div class="tt-row"><span>单品耗费:</span><b>${cost}</b></div>` : ''}
        ${note ? `<div style="margin-top:4px;font-size:0.7rem;color:#C4BCA9;">${note}</div>` : ''}
      `;
      tooltip.style.display = 'block';
    });
    
    el.addEventListener('mousemove', (e) => {
      const offset = 15;
      let left = e.pageX + offset;
      let top = e.pageY + offset;
      
      // Boundary detection
      if (left + 260 > window.innerWidth) {
        left = e.pageX - 270;
      }
      
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    });
    
    el.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  });
}
```

---

## 4. Chart-to-Table Cross-Highlighting

Syncs interactions between SVG visual elements and data table rows.

```javascript
function initCrossHighlight(chartSelector, tableSelector) {
  const chartElements = document.querySelectorAll(`${chartSelector} [data-source]`);
  const tableRows = document.querySelectorAll(`${tableSelector} tbody tr[data-source]`);
  
  chartElements.forEach(el => {
    const sourceId = el.getAttribute('data-source');
    el.addEventListener('mouseenter', () => {
      tableRows.forEach(row => {
        if (row.getAttribute('data-source') === sourceId) {
          row.style.background = 'rgba(46, 111, 102, 0.15)'; // Highlight
        } else {
          row.style.opacity = '0.4';
        }
      });
    });
    el.addEventListener('mouseleave', () => {
      tableRows.forEach(row => {
        row.style.background = '';
        row.style.opacity = '1';
      });
    });
  });
}
```

---

## 5. One-Click Copy for SQL & Code Blocks

Adds a floating "复制" button with tactile status feedback.

```javascript
function initCopyButtons() {
  document.querySelectorAll('pre code').forEach((codeBlock) => {
    const pre = codeBlock.parentNode;
    if (pre.querySelector('.copy-btn')) return;
    
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.innerText = '复制 SQL';
    btn.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--surface);
      border: 1px solid var(--rule-2);
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.68rem;
      padding: 3px 8px;
      cursor: pointer;
      color: var(--ink-2);
      border-radius: 2px;
      transition: all 0.15s ease;
    `;
    
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(codeBlock.innerText);
      const originalText = btn.innerText;
      btn.innerText = '已复制 ✓';
      btn.style.color = 'var(--risk)';
      btn.style.borderColor = 'var(--risk)';
      setTimeout(() => {
        btn.innerText = originalText;
        btn.style.color = 'var(--ink-2)';
        btn.style.borderColor = 'var(--rule-2)';
      }, 1500);
    });
    
    pre.appendChild(btn);
  });
}
```
