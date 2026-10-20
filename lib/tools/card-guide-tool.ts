/**
 * card-guide-tool.ts — Luc Interactive Card 设计手册工具
 *
 * Agent 在首次生成 interactive card 前调用。返回完整的设计规范：
 * CSS 变量、排版规则、色彩体系、组件规范、禁令清单、用例模板。
 * 等价于 Claude Visualizer 的 read_me。
 */

import { Type, StringEnum } from "../pi-sdk/index.ts";
import { toolOk } from "./tool-result.ts";

// ── 设计手册全文 ──
// 注入到 Agent 上下文。精度对标 Claude Visualizer read_me，
// 视觉语言完全遵循 Luc 主题 + KAMI 墨染色系。

const HANDBOOK = `# Luc Interactive Card Design Handbook

You are generating HTML/SVG fragments that render inside an iframe in Luc's chat.
Follow every rule below. Violations break the visual language.

## §0 Design philosophy

- Paper extension: the card is a sheet of paper rising from the conversation. It belongs to this notebook, not an alien embed.
- Flat + warm: solid fills only. No gradient, shadow, blur, glow, noise texture, or mesh background. Background is warm off-white paper, never cold gray.
- Compact: the card shows only visual content. Explanatory text belongs in your normal response outside the tool call.
- Serif-first: body text uses the serif stack (EB Garamond / Noto Serif SC). Data labels and UI controls use the system sans-serif.
- Quiet motion: no bounce, no spring, no scale animations. If you must animate, use opacity transitions only, duration ≤ 0.15s.

## §1 Streaming rules

Your HTML streams token-by-token into the iframe. The browser renders progressively.

- Put \`<style>\` short and early (≤ 15 lines), then content HTML, then \`<script>\` last.
- Prefer \`style="..."\` inline over \`<style>\` blocks — elements and styles arrive together, preventing flash of unstyled content.
- Gradients, drop-shadow, and blur flash during incremental DOM diffs. Use solid flat fills.
- No \`display: none\`, tabs, or carousels — hidden content is invisible during streaming, breaking the progressive experience.
- No comments (\`<!-- -->\` / \`/* */\`) — they waste tokens and interfere with streaming parsing.
- \`<script>\` runs only after the stream finishes. \`getElementById\` etc. will find the complete DOM.

## §2 Structure rules

You write only the content fragment. The host wraps it with:
- \`<!DOCTYPE html>\` / \`<html>\` / \`<head>\` / \`<body>\`
- CSS variable injection (§3, all variables listed below)
- Base reset (box-sizing / margin / padding)
- Height reporting script (ResizeObserver)
- Body padding: \`12px 16px\`
- Default font: \`var(--font-serif)\`

Do NOT repeat any of these elements. Do NOT emit DOCTYPE, \`<html>\`, \`<head>\`, or \`<body>\` tags.

## §3 CSS variables (host-injected, follow current theme)

### Paper tones
| Variable | Value | Meaning |
|----------|-------|---------|
| \`--bg\` | \`#F5EFE4\` | Main paper surface |
| \`--bg-card\` | \`#FBF7EE\` | Raised card (brighter than main) |
| \`--sidebar-bg\` | \`#EFE8DB\` | Deeper substrate |

### Ink (5 stops)
| Variable | Value | Meaning |
|----------|-------|---------|
| \`--text\` | \`#2A2622\` | Dense ink (headings, primary text) |
| \`--text-light\` | \`#4A433C\` | Secondary text |
| \`--text-muted\` | \`#6B6158\` | Tertiary (captions, labels) |

### Structure line
| Variable | Value | Meaning |
|----------|-------|---------|
| \`--border\` | \`#D8CFBE\` | Primary divider |

### Seal blue (sole accent)
| Variable | Value | Meaning |
|----------|-------|---------|
| \`--accent\` | \`#537D96\` | Emphasis · distant mountain blue |
| \`--accent-hover\` | \`#3F6179\` | Pressed state |
| \`--accent-light\` | \`rgba(83,125,150,0.08)\` | Tint fill |
| \`--accent-rgb\` | \`83, 125, 150\` | For custom alpha |

### Semantic colors (ink-dyed, minimal)
| Variable | Value | Meaning |
|----------|-------|---------|
| \`--green\` | \`#4A6B4A\` | Success · ink green |
| \`--danger\` | \`#8B2C1F\` | Error · deep vermilion |

### KAMI extended palette (from Luc's notebook design language)
These are not injected as CSS variables but belong to Luc's full color spectrum. Use them directly as hex values.

| Hex | Name | Usage |
|-----|------|-------|
| \`#1B365D\` | Ink blue | Deep emphasis, chart secondary, active state |
| \`#9D5F4D\` | Seal ochre (stamp) | Warm accent, annotations, decorative marks |
| \`#E4ECF5\` | Ink blue light | Badge/chip/tag background |
| \`#EEF2F7\` | Ink blue whisper | Blockquote bar / info strip background |
| \`#FFFDF7\` | Sheet white | Brightest content surface |
| \`#FAF9F5\` | Ivory | Secondary panel |
| \`#E8E6DC\` | Sand | Deeper layer, depth differentiation |

KAMI usage rules:
- Accent (\`#537D96\`) is primary. Ink blue (\`#1B365D\`) is its deep variant — same color family.
- Seal ochre (\`#9D5F4D\`) is for warm accents, like a vermilion seal stamped on paper. Use sparingly, never as large fill.
- Paper gradation (sheet → ivory → paper → sand) expresses depth hierarchy — deeper layers are darker.
- Ink blue light / whisper backgrounds pair with \`#1B365D\` text.

### Layout tokens
| Variable | Value | Meaning |
|----------|-------|---------|
| \`--radius-chat-card\` | \`4px\` | Card outer radius |
| \`--radius-chat-card-inner\` | \`max(2px, calc(var(--radius-chat-card) - 2px))\` | Inner content radius |
| \`--space-xs\` | \`0.25rem\` (4px) | Tight spacing |
| \`--space-sm\` | \`0.5rem\` (8px) | Small spacing |
| \`--space-md\` | \`1rem\` (16px) | Medium spacing |
| \`--space-lg\` | \`1.5rem\` (24px) | Large spacing |

### Fonts
| Variable | Value |
|----------|-------|
| \`--font-serif\` | \`'EB Garamond', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif\` |
| \`--font-ui\` | System sans-serif |
| \`--font-mono\` | \`'JetBrains Mono', ui-monospace, monospace\` |

## §4 Typography rules

| Element | Size | Weight | Line-height | Color |
|---------|------|--------|-------------|-------|
| h1 | 1.35rem | 500 | 1.25 | \`var(--text)\` |
| h2 | 1.1rem | 500 | 1.3 | \`var(--text)\` |
| h3 | 0.95rem | 500 | 1.35 | \`var(--text)\` |
| Body (p) | 0.9rem | 400 | 1.65 | \`var(--text)\` |
| Caption / label | 0.75rem | 400 | 1.3 | \`var(--text-muted)\` |
| Metric value | 1.6rem | 600 | 1.15 | \`var(--accent)\` |

Rules:
- h2 has a left bar: \`border-left: 2px solid var(--accent); padding-left: 8px; border-radius: 0\` (no radius on single-sided borders)
- \`<strong>\` = \`font-weight: 500; color: var(--accent)\`
- Only weights 400 and 500 are allowed. 600 is metric values only. Never use 700.
- Sentence case always. Never Title Case, never ALL CAPS. Everywhere, including SVG labels.
- Never use font-size below 11px.
- No bold inside body paragraphs. Bold is for headings and labels only.
- Round every displayed number: use \`Math.round()\`, \`.toFixed(n)\`, or \`Intl.NumberFormat\`. Float artifacts must never reach the screen.

## §5 Color usage rules

- Colors encode meaning, not sequence. Same-type elements share one color.
- Max 2 accent colors per card (accent + at most 1 semantic color).
- Text on colored background: use the darkest shade from that same color family. Never plain black or generic gray.
- No hardcoded color values (\`#333\`, \`rgb(0,0,0)\`, etc.). All colors via CSS variables or the KAMI palette table above.
- Default background: transparent (inherits host \`--bg-card\`). For area differentiation: \`var(--bg)\` or \`rgba(var(--accent-rgb), 0.06)\`.

### Chart palette (6 colors, all from Luc/KAMI ink-dyed family)
1. Distant mountain blue \`#537D96\` (accent, primary, default first choice)
2. Ink blue \`#1B365D\` (deep contrast)
3. Seal ochre \`#9D5F4D\` (warm tone)
4. Ink green \`#4A6B4A\` (nature / success data)
5. Warm gray \`#8F867B\` (neutral / baseline / secondary series)
6. Deep vermilion \`#8B2C1F\` (error / negative meaning only)

- Pick 2-3 from the palette per chart. Never exceed 4.
- Fill areas: use the color at 0.08 alpha (\`rgba(r,g,b, 0.08)\`). Strokes/lines use full color.
- On ink blue light (\`#E4ECF5\`) background, text is ink blue (\`#1B365D\`).
- On accent light background, text is \`var(--accent-hover)\`.

## §6 Component specs

### Card
\`\`\`css
background: var(--bg-card);
border-radius: var(--radius-chat-card);
padding: 1rem 1.25rem;
\`\`\`

### Divider (hr)
\`\`\`css
border: none;
border-top: 0.5px solid var(--border);
margin: 0.8em 0;
\`\`\`

### Table
\`\`\`css
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th { text-align: left; font-weight: 500; color: var(--text-light); padding: 6px 8px; border-bottom: 1px solid var(--border); }
td { padding: 5px 8px; border-bottom: 0.5px solid rgba(0,0,0,0.06); color: var(--text); }
tr:last-child td { border-bottom: none; }
\`\`\`
For tables that may overflow: use \`table-layout: fixed\` and set explicit column widths.

### Metric values
\`\`\`css
.metric-value { font-size: 1.6rem; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
.metric-label { font-size: 0.75rem; color: var(--text-muted); }
\`\`\`
Metric groups: flex wrap, \`gap: 12px 20px\`, each metric min-width 72px.

### Badge / pill / tag
\`\`\`css
display: inline-flex; align-items: center; gap: 4px;
padding: 2px 8px;
font-size: 0.75rem; font-weight: 500;
border-radius: var(--radius-chat-card);
background: var(--accent-light);
color: var(--accent-hover);
\`\`\`
For ink blue variant: \`background: #E4ECF5; color: #1B365D;\`
For stamp variant: \`background: rgba(157,95,77,0.08); color: #9D5F4D;\`

### Button
\`\`\`css
border: 0.5px solid var(--border);
border-radius: var(--radius-chat-card);
background: transparent;
color: var(--accent);
padding: 4px 10px;
font-family: var(--font-serif);
font-size: 0.82rem;
font-weight: 500;
cursor: pointer;
\`\`\`
Hover: \`background: var(--accent-light)\`. No :active scale animation (Luc quiet motion principle).

### Blockquote (\`<blockquote>\`)
\`\`\`css
border-left: 2px solid var(--accent);
padding: 4px 0 4px 12px;
border-radius: 0; /* no radius on single-sided borders */
color: var(--text-muted);
font-style: italic;
\`\`\`

### Code
\`\`\`css
pre { background: var(--bg); border: 0.5px solid var(--border); border-radius: var(--radius-chat-card); padding: 8px 12px; overflow-x: auto; }
code { font-family: var(--font-mono); font-size: 0.82rem; color: var(--text); }
\`\`\`

## §7 Forbidden patterns

| Forbidden | Reason |
|-----------|--------|
| gradient / drop-shadow / blur / glow | Streaming flicker + violates flat design |
| emoji | Luc uses SVG stroke icons only |
| \`position: fixed\` | iframe viewport auto-sizes to content height; fixed elements collapse the layout. For overlays: use a normal-flow wrapper with min-height and flex centering as a faux viewport |
| \`localStorage\` / \`sessionStorage\` | Sandbox does not grant storage access |
| \`eval()\` / \`Function()\` | Security policy |
| \`window.open()\` / navigation | Sandbox does not grant allow-top-navigation |
| Form submission | Sandbox does not grant allow-forms |
| \`<!DOCTYPE>\` / \`<html>\` / \`<head>\` / \`<body>\` | Host wraps the fragment; duplicates cause conflicts |
| Comments \`<!-- -->\` / \`/* */\` | Waste tokens, break streaming parsing |
| \`display: none\` / tabs / carousel | Hidden content invisible during stream |
| Font-size < 11px | Readability floor |
| Font-weight 700 | Luc allows 400/500 only. 600 for metrics only |
| Title Case / ALL CAPS | Luc uses sentence case exclusively |
| Dark or colored outer background | Background must be transparent; host provides paper tone |
| Hardcoded color values | Must use CSS variables or KAMI palette table. Hardcoded colors break on theme switch |
| Rounded corners on single-sided borders | \`border-left\` + \`border-radius\` looks broken. Set \`border-radius: 0\` for accent bars |
| Nested scrolling containers | Auto-fit height instead |
| \`<img>\` with external URLs | Sandbox may block; draw with SVG or use CSS |

## §8 Complexity budget

| Dimension | Limit |
|-----------|-------|
| Title / subtitle | ≤ 5 words. Detail goes in your response text |
| Accent colors | ≤ 2 (accent + at most 1 semantic color) |
| Horizontal elements | ≤ 4 at full width. 5+ must wrap or split |
| \`<style>\` block | ≤ 15 lines. Prefer inline styles |

## §9 Layout modes

- **Editorial** (explanatory content): no card wrapper, content flows naturally. Use \`padding: 1rem 0\` for breathing room.
- **Card** (bounded object: data card, contact, receipt): single card wraps all content.
- **Metric grid**: flex wrap, \`gap: 12px 20px\`, each metric min-width 72px.
- **Responsive columns**: \`grid-template-columns: repeat(auto-fit, minmax(160px, 1fr))\`
- **Grid overflow safety**: always use \`minmax(0, 1fr)\` instead of bare \`1fr\` to prevent children from pushing columns past the container width.

Card container width is approximately 680-900px depending on the chat viewport.

## §11 SVG rules

- \`<svg>\` must declare \`viewBox\`. Do not hardcode \`width\` / \`height\` attributes (the host sets width: 100%).
- \`<text>\` uses \`font-family: var(--font-serif)\`
- All colors via CSS variables or KAMI palette.
- Default corner radius: \`rx="2"\` (Luc's square-corner style). Larger values only for deliberate pill shapes.
- \`stroke-width="1"\` or \`1.5\`. Never exceed 2.
- Use \`role="img"\` on the root \`<svg>\`, with \`<title>\` and \`<desc>\` children for accessibility.

## §12 Accessibility

- Begin HTML cards with a visually-hidden heading: \`<h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Summary of this visualization</h2>\`
- SVG cards use \`role="img"\` with \`<title>\` and \`<desc>\`.
- Interactive controls need \`aria-label\` when no visible text label is present.
- Color is never the sole means of conveying information — pair with text labels or patterns.

## §13 Use case templates

### Metric dashboard
Metric values on top (flex grid), optional trend line below.
\`\`\`html
<div style="display:flex;flex-wrap:wrap;gap:12px 20px;margin-bottom:1rem">
  <div style="min-width:72px">
    <div style="font-size:0.75rem;color:var(--text-muted)">Revenue</div>
    <div style="font-size:1.6rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">¥2.4M</div>
  </div>
  <div style="min-width:72px">
    <div style="font-size:0.75rem;color:var(--text-muted)">Growth</div>
    <div style="font-size:1.6rem;font-weight:600;color:#4A6B4A;font-variant-numeric:tabular-nums">+12%</div>
  </div>
</div>
\`\`\`

### Data record card
Wrap in a single card. All sans-serif since it is pure UI.
\`\`\`html
<div style="background:var(--bg-card);border-radius:var(--radius-chat-card);padding:1rem 1.25rem">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:0.8rem">
    <div style="width:40px;height:40px;border-radius:50%;background:var(--accent-light);display:flex;align-items:center;justify-content:center;color:var(--accent);font-weight:500;font-family:var(--font-ui)">EU</div>
    <div>
      <div style="font-weight:500;color:var(--text)">Example User</div>
      <div style="font-size:0.75rem;color:var(--text-muted)">Developer</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:0.85rem;font-family:var(--font-ui)">
    <tr><td style="padding:5px 8px;color:var(--text-muted);width:30%">Email</td><td style="padding:5px 8px;color:var(--text)">example@mail.com</td></tr>
    <tr><td style="padding:5px 8px;color:var(--text-muted)">Location</td><td style="padding:5px 8px;color:var(--text)">Example City</td></tr>
  </table>
</div>
\`\`\`

### Interactive explainer
Controls on top, result below. No card wrapper — whitespace is the container.
\`\`\`html
<h2 style="font-size:1.1rem;font-weight:500;border-left:2px solid var(--accent);padding-left:8px;border-radius:0;margin:0 0 0.8rem">Compound interest</h2>
<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:1rem">
  <label style="font-size:0.82rem;color:var(--text-light);display:flex;flex-direction:column;gap:4px">
    Principal
    <input type="range" min="1000" max="100000" value="10000" id="principal" style="width:160px">
    <span id="principal-val" style="font-variant-numeric:tabular-nums;color:var(--accent)">¥10,000</span>
  </label>
  <label style="font-size:0.82rem;color:var(--text-light);display:flex;flex-direction:column;gap:4px">
    Rate (%)
    <input type="range" min="1" max="20" value="5" id="rate" style="width:120px">
    <span id="rate-val" style="color:var(--accent)">5%</span>
  </label>
</div>
<div id="result" style="font-size:1.6rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">¥12,763</div>
<script>
  // Compute compound interest on slider change
  const pEl = document.getElementById('principal');
  const rEl = document.getElementById('rate');
  function update() {
    const p = Number(pEl.value), r = Number(rEl.value) / 100;
    document.getElementById('principal-val').textContent = '¥' + Math.round(p).toLocaleString();
    document.getElementById('rate-val').textContent = r * 100 + '%';
    document.getElementById('result').textContent = '¥' + Math.round(p * Math.pow(1 + r, 5)).toLocaleString();
  }
  pEl.addEventListener('input', update);
  rEl.addEventListener('input', update);
</script>
\`\`\`

### Comparison grid
Side-by-side cards for options. Use badges for differentiators.
\`\`\`html
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
  <div style="background:var(--bg-card);border:0.5px solid var(--border);border-radius:var(--radius-chat-card);padding:1rem 1.25rem">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:0.5rem">
      <span style="font-weight:500;color:var(--text)">Option A</span>
      <span style="display:inline-flex;padding:2px 8px;font-size:0.75rem;font-weight:500;border-radius:var(--radius-chat-card);background:#E4ECF5;color:#1B365D">recommended</span>
    </div>
    <p style="font-size:0.85rem;color:var(--text-light);margin:0">Lower cost, simpler setup</p>
  </div>
  <div style="background:var(--bg-card);border:0.5px solid var(--border);border-radius:var(--radius-chat-card);padding:1rem 1.25rem">
    <span style="font-weight:500;color:var(--text)">Option B</span>
    <p style="font-size:0.85rem;color:var(--text-light);margin:0.3em 0 0">More features, higher cost</p>
  </div>
</div>
\`\`\`

### Process diagram / timeline (SVG)
\`\`\`html
<svg viewBox="0 0 600 120" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>Process flow</title>
  <desc>Three steps: Plan, Build, Ship</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)"/>
    </marker>
  </defs>
  <rect x="20" y="35" width="120" height="50" rx="2" fill="rgba(83,125,150,0.08)" stroke="var(--accent)" stroke-width="1"/>
  <text x="80" y="65" text-anchor="middle" font-family="var(--font-serif)" font-size="14" font-weight="500" fill="var(--text)">Plan</text>
  <line x1="150" y1="60" x2="220" y2="60" stroke="var(--accent)" stroke-width="1" marker-end="url(#arrow)"/>
  <rect x="230" y="35" width="120" height="50" rx="2" fill="rgba(83,125,150,0.08)" stroke="var(--accent)" stroke-width="1"/>
  <text x="290" y="65" text-anchor="middle" font-family="var(--font-serif)" font-size="14" font-weight="500" fill="var(--text)">Build</text>
  <line x1="360" y1="60" x2="430" y2="60" stroke="var(--accent)" stroke-width="1" marker-end="url(#arrow)"/>
  <rect x="440" y="35" width="120" height="50" rx="2" fill="rgba(27,54,93,0.08)" stroke="#1B365D" stroke-width="1"/>
  <text x="500" y="65" text-anchor="middle" font-family="var(--font-serif)" font-size="14" font-weight="500" fill="var(--text)">Ship</text>
</svg>
\`\`\`

## §14 Fallback rules

When no template above fits:
- Explanatory content → editorial layout (no card)
- Bounded object → card layout
- All design rules still apply
`;

export function createCardGuideTool() {
  return {
    name: "luc_card_guide",
    label: "Interactive Card Guide",
    description:
      "Returns the Luc Interactive Card Design Handbook — CSS variables, colors, typography, layout rules, " +
      "component specs, forbidden patterns, and use case templates. " +
      "Call before your first show_card call to load the design system. " +
      "Do NOT mention or narrate this call to the user — it is an internal setup step. " +
      "Call it silently and proceed directly to creating the card.",
    parameters: Type.Object({
      modules: Type.Optional(
        Type.Array(
          StringEnum(["diagram", "chart", "interactive", "data_record"]),
          { description: "Which module(s) to load. Pick all that fit. Currently all modules return the full handbook." },
        ),
      ),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "read",
        kind: "read",
        capability: "luc_card_guide.read",
      }),
    },
    execute: async (_toolCallId: string, _params: { modules?: string[] }) => {
      // v1: always return the full handbook regardless of modules.
      // Future: modular assembly by topic.
      return toolOk(HANDBOOK);
    },
  };
}
