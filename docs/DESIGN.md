# StreamTunnel — Design Brief (v2)

The user rejected v1 as "AI slop" (centered hero + tagline, two icon cards, purple→cyan gradients, glow,
chips full of jargon, native title bar). v2 must look like a **purpose-built tool for gamers** — closer to a
piece of hardware software (a capture card utility, a racing HUD, an F1 timing screen) than to a SaaS
landing page. Calm, dense, confident, fast.

## 1. Hard rules (anything here = rejected)
* **No gradients anywhere** (backgrounds, buttons, text, borders). No glow, no blur, no glassmorphism,
  no `backdrop-filter`, no drop-shadow decoration (only a 1-px hairline or a flat surface change).
* No centered "hero" with logo + slogan. No marketing copy. No emoji. No icon-in-rounded-square tiles.
* No pill "chips" rows with technical words. Never show: Host, Broker, Encoder, Signaling, Hops, WebRTC,
  MQTT, STUN in the UI (only inside the "Erweitert" dialog where unavoidable, phrased plainly).
* Not more than **one** accent-filled element visible per screen (the primary action).
* Border radius: **4 px** for controls, **6 px** for panels, **0** for the video stage. No 12–16 px bubbly radii.
* No light theme. Dark only (it is a streaming tool; the video is the light source).
* **No native title bar** (`decorations:false`) — we draw our own 40 px strip.
* **Zero layout shift.** The app is a fixed 100vh layout; `html, body { overflow: hidden }`. Only explicit
  list regions scroll, and every scroll container has `scrollbar-gutter: stable` plus a thin dark scrollbar
  (`scrollbar-width: thin; scrollbar-color: #2A2A2E transparent`). Expanding/collapsing anything, a scrollbar
  appearing, hover states, loading states or changing numbers must never move other content
  (tabular numerals, fixed row heights, reserved space for status text). The user explicitly called this out.

## 2. Tokens
```
--bg:        #0B0B0C   app background
--bg-1:      #121214   raised surface (panels, inputs)
--bg-2:      #1A1A1D   hover / selected row
--line:      rgba(255,255,255,0.07)   hairlines
--line-2:    rgba(255,255,255,0.14)   input borders, focus-adjacent
--text:      #EDEDEA   primary text (warm off-white)
--text-2:    #9C9C98   secondary
--text-3:    #5F5F5C   tertiary / labels
--accent:    #E4FF3C   electric lemon — primary action fill, focus ring, active selection marker
--accent-ink:#0B0B0C   text on accent
--live:      #FF3B2F   LIVE dot/label only
--ok:        #3EE08F   connected dot only
--warn:      #FFB224   warnings (text + small icon only, never a filled box)
```
Accent usage: primary button fill, 2-px left marker on the selected list row, focus ring
(`outline: 2px solid var(--accent); outline-offset: 2px`), the latency number in the HUD. Nothing else.

## 3. Typography (zero downloaded bytes — Windows system fonts)
* **Display / numbers / code**: `"Bahnschrift", "DIN Alternate", "Segoe UI Variable Display", sans-serif`
  — DIN-style, technical. Use `font-stretch: condensed` / family `"Bahnschrift SemiCondensed"` for big
  numerals and the code. Always `font-variant-numeric: tabular-nums`.
* **UI text**: `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`, 13–14 px, weight 400/600.
* **Labels**: Bahnschrift 11 px, uppercase, `letter-spacing: 0.14em`, `--text-3`. Used sparingly as section
  heads ("IM TUNNEL", "CODE", "QUALITÄT").
* Scale: 11 / 13 / 14 / 18 / 28 / 44 / 72 px. Headlines Bahnschrift 600, tight (`letter-spacing:-0.01em`).
* Verify in a headless screenshot that Bahnschrift actually renders (it ships with Windows 10 1709+).

## 4. Window chrome (frameless)
40 px top strip, full width, background = page background (no separate color), `data-tauri-drag-region` on
the empty area (double-click maximizes). Left: wordmark `STREAMTUNNEL` (Bahnschrift SemiCondensed 12 px,
letter-spacing 0.2em, `--text-3`) — inside a tunnel: the code next to it as a quiet hint. Right: settings
(gear), then minimize / maximize-restore / close as 46×40 flat buttons (Windows-like hover: `--bg-2`; close
hover `#C42B1C` with white glyph). Icons 1.5 px stroke, 16 px.
In the **watch view** the strip is part of the auto-hiding overlay (hidden when idle → video edge to edge);
in fullscreen it never shows. In a plain browser (no Tauri) the window buttons are not rendered.

## 5. Screens

### 5.1 Start (no tunnel yet)
Full window split in two halves by a single vertical hairline, content vertically centered, left-aligned.
```
┌ STREAMTUNNEL ─────────────────────────────────────────────── ⚙  ─  ☐  ✕ ┐
│                                   │                                      │
│  BEITRETEN                        │  NEUER TUNNEL                        │
│  Code eingeben                    │  Erstelle einen Tunnel und           │
│                                   │  schick deinen Freunden den Code.    │
│  [K][7][F][3][Q] – [X][9][M][Z][D]│                                      │
│                                   │  [ Tunnel erstellen ]  (outline)     │
│  [  Beitreten  →  ]  (accent)     │                                      │
│                                   │                                      │
│  Name  Seb  ✎                     │                                      │
└───────────────────────────────────┴──────────────────────────────────────┘
```
* Code entry = 10 visual cells (2 groups of 5, Bahnschrift 28 px, cell 40×52, `--bg-1`, 1 px `--line-2`,
  active cell outlined in accent) driven by ONE real `<input id="join-code">` (transparent, covers the cells,
  `autocomplete=off`, `spellcheck=false`), so typing, paste of an invite text, Backspace and E2E
  `value=…; dispatchEvent('input')` all work. Invalid char → cell shakes once (80 ms ×3, transform only).
* Name: inline editable text (`#name` is a real input styled as text with a pencil), persisted.

### 5.2 Tunnel view (the main screen)
Two columns: left rail 300 px (members), right stage.
```
┌ STREAMTUNNEL  K7F3Q-X9MZD ─────────────────────────────────── ⚙  ─  ☐  ✕ ┐
│ CODE                          │                                          │
│ K7F3Q-X9MZD        ⧉ kopieren │   (stage)                                │
│ Schick den Code an Freunde.   │                                          │
│ ───────────────────────────── │   Niemand teilt gerade.                  │
│ IM TUNNEL  3                  │   [ Bildschirm teilen ]  (accent)        │
│ ● Lena        LIVE  Forza H6  │                                          │
│   1440p · 60 · 2 schauen  ▶   │   — or, if members are live: one large   │
│ ○ Max                         │   row per live stream:                   │
│ ○ Seb (du)                    │   LENA  ● LIVE 12:31                     │
│                               │   Forza Horizon 6 · 1440p 60 · Ton       │
│                               │   [ Ansehen ]                            │
│ ───────────────────────────── │                                          │
│ [ Teilen ]   Tunnel verlassen │                                          │
└───────────────────────────────┴──────────────────────────────────────────┘
```
* Code: Bahnschrift SemiCondensed 30 px, click = copy (inline "Kopiert" for 1.2 s, no toast). Second action
  "Einladung kopieren" as a small text button.
* Member row: 8 px status dot (live = `--live`, connected = `--ok`, idle = `--text-3` ring), name 14 px,
  right-aligned meta in Bahnschrift 12 px `--text-2`. Live rows get a second line (title · res · fps ·
  "N schauen"). Hover `--bg-2`; selected/watched row: 2 px accent marker on the left. Click a live row = watch.
* When **I share**, the stage shows my control panel (§5.4) instead of the empty state.

### 5.3 Sharing starts with ONE click (no setup screen — the user explicitly hated it)
* "Teilen" (rail button and the empty-stage accent button) opens the OS picker **immediately** with the
  saved/default quality (1440p · 60 FPS · Auto-Bitrate · Ton an). No intermediate form, no preset grid,
  no info box.
* Under the empty-stage button, ONE quiet line in `--text-3` (Bahnschrift step numbers):
  `Im Dialog: 1 Fenster · 2 Spiel · 3 „App-Audio ebenfalls teilen“`.
* Quality is changed live in the sharing panel (§5.4). Max. direkte Zuschauer, Upload-Limit,
  Zuschauer bestätigen, Codec and Auflösung live in the settings sheet (§5.6) under "Teilen".
* `?test` adds a quiet text button "Testbild senden" next to the main button.

### 5.4 While I share (stage)
```
DU TEILST  ● LIVE 00:12:31                                  [ Beenden ]  (red outline)
Forza Horizon 6 · Ton an                                    Quelle wechseln
────────────────────────────────────────────────────────────────────────
ZUSCHAUER 2                    Bild   Ping   Verbindung
Max        ● verbunden         1440p60  24 ms  Direkt          ✕ (on hover)
Tom        ● verbunden         1440p58  31 ms  über Max         ✕
────────────────────────────────────────────────────────────────────────
QUALITÄT   FPS [30|60|120]   Inhalt [Flüssig|Ausgewogen|Scharf]   Bitrate ────●── Auto
□ Raum sperren   □ Vorschau
```
* Viewer list as a real aligned table (Bahnschrift numbers). Empty: "Noch schaut niemand zu." in `--text-3`.
* Segmented controls: flat, 1 px `--line-2`, selected segment `--bg-2` + accent underline 2 px.
* Warnings inline (no boxes): `--warn` icon + text, e.g. "Kein Ton — Quelle wechseln und „App-Audio ebenfalls
  teilen“ einschalten", "Hohe CPU-Last: Software-Kodierung aktiv".
* Pending approvals appear as rows with "Zulassen" / "Ablehnen" text buttons.

### 5.5 Watching (full window)
* Video fills the window (`object-fit: contain`, black). Nothing else visible when idle (2.5 s).
* On mouse move: top strip (40 px, `rgba(11,11,12,0.72)` flat, no blur) with ← back to tunnel, name,
  `● LIVE`, latency `27 ms` in accent Bahnschrift, then window buttons. Bottom strip (56 px, same flat
  scrim): volume, then right-aligned icon buttons: stats (HUD), latency mode toggle ("Niedrigste Latenz" /
  "Flüssig" as a text toggle), mini player, fullscreen. 36×36 icon buttons, no borders, hover `--bg-2`.
* Stats = **HUD** top-left, like an FPS overlay: Bahnschrift 12 px, tabular, no panel box — just a
  `rgba(0,0,0,0.55)` backing per line block, key in `--text-3`, value in `--text`; latency value in accent.
  Lines: `1440p 60` / `13.2 Mbit/s AV1` / `Latenz ~27 ms` / `Ping 18 · Puffer 6 · Dekod. 1` / `Verlust 0.0 %`
  / `Direkt` (or `über Max`).
* State overlays (waiting / connecting / reconnecting / paused / ended / failed …) centered, small: a 1-px
  progress line or a plain sentence + one action. No spinners with glow.
* Mini player (Tauri): window always-on-top, min size lifted to 320×180, resized to 480×270, decorations
  stay off; restore previous size/min-size on exit.

### 5.6 Erweitert (settings)
Right-side panel (sheet, 380 px, slides in 120 ms), not a centered modal. Plain field list.

## 6. Motion
120 ms ease-out opacity/translate for overlays and sheets; nothing bounces, nothing pulses except the
LIVE dot (1.6 s opacity 1→0.35) and the "waiting" 1-px progress line. `prefers-reduced-motion` → none.

## 7. Copy (German, "du", short)
Buttons are verbs: "Beitreten", "Tunnel erstellen", "Teilen", "Fenster wählen", "Ansehen", "Beenden",
"Quelle wechseln", "Tunnel verlassen". Sentences only where needed, no exclamation marks.

## 8. Quality bar
Before finishing, render every screen headless at 1100×760 and 760×640 (script:
`scratchpad/shots/shots.mjs` pattern) and fix anything that looks generic, misaligned, cramped or
inconsistent. The result should feel like it was designed by one opinionated person.
