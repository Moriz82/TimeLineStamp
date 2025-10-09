# TimeLineStamp

TimeLineStamp lets you drop lightweight timestamps on highlighted passages or embedded images and review every stamp across your vault on a dedicated timeline.

## Features
- Highlight any text selection or supported image embed and instantly stamp it with the current time or a custom time.
- Auto-detect existing `timeline-stamp-label` spans across your vault (rescans every 5 seconds) so the timeline always reflects the latest state.
- Browse all stamps in a sortable timeline view with relative time, snippet previews, and one-click navigation back to the source line.
- Optional auto-open of the timeline view after stamping and configurable Moment.js format string for your timestamps.

## Installation
### Option 1
1. Ensure you have [Node.js](https://nodejs.org/) 16+ installed.
2. Clone or copy this repository into your Obsidian plugins development area.
3. In the plugin folder, install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
4. Copy the build output (`manifest.json`, `main.js`, `styles.css`, and optionally `data.json`) into your vault’s `.obsidian/plugins/timeline-stamp/` directory.
### Option 2 [WIP not on Community plugins page]
In Obsidian, head to **Settings → Community plugins**, reload the list if needed, and enable **TimeLineStamp**.
## Usage
- Create a Keybinding for the following or:
- Highlight text or an image embed inside a Markdown note, open the command palette, and run either:
  - `TimeLineStamp: Timestamp selection with current time`
  - `TimeLineStamp: Timestamp selection with chosen time`

- Stamped text is highlighted (keeps existing highlights intact) and tagged with a pill label showing the formatted time.

- Click the clock ribbon icon (or run `TimeLineStamp: Open TimeLineStamp timeline`) to open the timeline pane; click again to close it.

- The timeline pane displays every stamp with:
  - Absolute and relative timestamps
  - Type badge (`Text` or `Image`)
  - Snippet or image reference
  - File name and line number
  Clicking an entry jumps directly to that location in your note.

### Auto-detection
Every 5 seconds the plugin rescans all Markdown files for stamped spans (`timeline-stamp-label`). Any changes, manual edits, or previously existing stamps are merged into the timeline automatically.

## Settings
Open **Settings → TimeLineStamp** to adjust:
- **Timestamp format**: Moment.js format string used for labels (defaults to `YYYY-MM-DD HH:mm`).
- **Auto-open timeline after stamping**: Opens the timeline pane as soon as a new stamp is created.

## Development
- Run `npm run dev` to rebuild automatically on file changes during development.
- The bundled output is placed at the repository root as `main.js` and `main.js.map`.

## Known Limitations
- The auto-scanner expects stamps to retain the `<span class="timeline-stamp-label">…</span>` structure; manual edits that remove the span will remove the entry from the timeline on the next scan.
- Image stamps support Markdown image embeds (`![]()` and `![[ ]]`); HTML `<img>` tags are not currently detected.
