# pdf

Display pdf in VSCode.

![screenshot](https://user-images.githubusercontent.com/3643499/84454816-98fcd600-ac96-11ea-822c-3ae1e1599a13.gif)

## Highlights

Select text in a PDF and press `Ctrl+S` (`Cmd+S` on macOS) (command **PDF: Toggle Highlight on Selection**) to highlight it.
Select any part of an existing highlight and press it again to remove that highlight.
**PDF: Remove All Highlights in This PDF** removes every highlight in the current PDF.

Highlights are saved by the extension per file path; the PDF file itself is not modified,
so they are only visible in this viewer. They work only where the PDF has selectable text.
The shortcut can be changed in Keyboard Shortcuts (`pdf-preview.toggleHighlight`).

## Contribute

### Upgrade PDF.js

1. Download latest [Prebuilt(older browsers)](https://mozilla.github.io/pdf.js/getting_started/#download).
1. Extract the ZIP file.
1. Overwrite ./lib/* by extracted directories.
   - If lib/web/viewer.html has changes, apply these changes to HTML template at pdfPreview.ts.
1. To not use sample pdf.
  - Remove sample pdf called `compressed.tracemonkey-pldi-09.pdf`.
  - Remove code about using sample pdf from lib/web/viewer.js.
    ```js
    defaultUrl: {
      value: "", // "compressed.tracemonkey-pldi-09.pdf"
      kind: OptionKind.VIEWER
    },
    ```
1. Remove the `Ctrl/Cmd+P` print `keydown` listener from lib/web/viewer.js (search for `window.print();` near `"keydown"`).
   It stops propagation, so VS Code never receives Quick Open (`Ctrl+P`) or the Command Palette (`Ctrl+Shift+P`).
1. Remove the `Ctrl/Cmd+S` (keyCode 83) `download` case from `webViewerKeyDown` in lib/web/viewer.js; that key is bound to the highlight command.

## Change log
See [CHANGELOG.md](CHANGELOG.md).

## License
Please see [LICENSE](./LICENSE)
