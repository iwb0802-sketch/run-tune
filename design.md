# Piano Tuning Scope — Design System

## Overview
Professional piano tuning measurement app. Technical minimalism aesthetic — precision instrument UI.

## Typography
- **Display/Body**: Noto Sans KR, system-ui, sans-serif
- **Monospace**: JetBrains Mono (cent values, frequencies, key numbers)
- Hierarchy: size + weight only. Dense data-forward layout.

## Color Palette (oklch)
### Semantic Tuner Tokens
| Token | Usage | Light |
|-------|-------|-------|
| `--primary` | Indigo — main actions | oklch(0.42 0.18 268) |
| `--in-tune` | ±2¢ accurate — emerald | oklch(0.62 0.16 152) |
| `--warn` | ±2~8¢ off — amber | oklch(0.74 0.16 75) |
| `--off` | >8¢ off — red | oklch(0.62 0.22 27) |
| `--precision` | Precision mode — violet | oklch(0.46 0.2 295) |
| `--instrument` | Strobe canvas dark surface | oklch(0.16 0.01 260) |
| `--reference` | 440Hz reference — amber gold | oklch(0.74 0.16 70) |

## Layout
- Max width: 6xl (container) for main content
- Grid: `1fr / 280px` sidebar on large screens
- Header: sticky, compact, functional — no decorative elements
- Cards: `bg-card border border-border rounded-xl shadow-sm p-4`

## Components
- Buttons: rounded-xl, active:scale-[0.97], semibold text
- Inputs: border-border, focus:border-primary/60
- Strobe canvas: dark bg-instrument (#080808), animated bars
- Progress: thin 1.5px bars, primary color
- Badges: semantic colors matching tuner tokens

## Key UX Patterns
- Auto-save mode: pitch detected → 0.8s timer → save (green indicator)
- Strobe tuner: canvas animation, freeze on ±0.8¢
- Undo stack: last N measurements deletable
- Session management: dropdown, rename, delete
- Export: PDF (print window) + PNG (canvas download)

## Dark Mode
Full dark mode support via `.dark` class on html element.
All semantic tokens remapped for dark backgrounds.
