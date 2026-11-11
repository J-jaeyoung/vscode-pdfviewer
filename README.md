# pdf

Display pdf in VSCode.

![screenshot](https://user-images.githubusercontent.com/3643499/84454816-98fcd600-ac96-11ea-822c-3ae1e1599a13.gif)

## Install

Download [vscode-pdfviewer.vsix](https://github.com/J-jaeyoung/vscode-pdfviewer/releases/download/latest-build/vscode-pdfviewer.vsix),
which is built from the latest `main` on every push.
In VS Code, open the Extensions view, click `...` → **Install from VSIX...** and pick the file
(or run `code --install-extension vscode-pdfviewer.vsix --force`), then reload the window.

- It replaces the Marketplace "vscode-pdf" if that is installed, since both use the ID `tomoki1207.pdf`.
  An extension installed from a VSIX is not auto-updated; install a newer build the same way.
- With Remote-SSH or WSL, install it locally. It runs on the local side and opens PDFs on the remote too.
- If LaTeX Workshop opens PDFs in its own viewer, use **Reopen Editor With...** → **Pdf Preview** on the tab.

## Highlights

Select text in a PDF and press `Ctrl+S` (`Cmd+S` on macOS) (command **PDF: Toggle Highlight on Selection**) to highlight it.
Select any part of an existing highlight and press it again to remove that highlight.
**PDF: Remove All Highlights in This PDF** removes every highlight in the current PDF.

To comment, select text (or part of a highlight) and press `Ctrl+Shift+S` (**PDF: Add/Edit Comment on Highlight**).
Commented highlights are orange (plain ones are yellow) and get a marker in the page margin; hover it to read the comment, click it to edit. Save an empty comment to remove it.
The **PDF Comments** view in the Explorer lists the comments of the PDFs in your workspace by page; click one to open the PDF at that spot.
A highlight with a comment is not removed by `Ctrl+S`; clear its comment first.

Highlights are saved by the extension per file path; the PDF file itself is not modified,
so they are only visible in this viewer. They work only where the PDF has selectable text.
The shortcut can be changed in Keyboard Shortcuts (`pdf-preview.toggleHighlight`).

## Zoom

While the PDF has focus, `Ctrl+=`/`Ctrl++` and `Ctrl+-` (`Cmd` on macOS, numpad keys too) zoom the PDF instead of the VS Code window.
Click outside the PDF to zoom the window as usual.

`Ctrl+O` (`Cmd+O`) fits the text body of the current page to the view width, with almost no margin,
and scrolls so the body's left edge lines up with the view; the line at the top of the view stays there.
The body is measured from the page's text, so margin notes such as arXiv stamps and line numbers are left out.
While the PDF has focus this replaces VS Code's Open File.

## fzf-style find

In the find bar (`Ctrl+F`), press `Ctrl+F` again to open an fzf-style finder; press it once more to go back to the normal find bar.
It lists matching lines best first (fzf's scoring) and jumps to the one you pick (`↑`/`↓`, `Enter` or click; `Esc` closes).
Matching is stricter than fzf's, so results stay close to what you typed:

- Space-separated words must appear in that order (`kernel exploit`).
- A word matches as a plain substring, or as pieces that each start a word in consecutive words:
  `dcred` finds "DirtyCred", `privesc` finds "privilege escalation", `uaf` finds "use-after-free" (but not "described").
- `'word` matches exactly, `!word` excludes lines; a word with an uppercase letter is case-sensitive.
- A phrase that wraps onto the next line still matches.

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
1. lib/build/pdf.js and pdf.worker.js carry a backport (search for `vscode-pdf:` and `case "Pattern":` in the `commonobj` handler):
   shading patterns inside Type3 glyphs (e.g. emoji in Chrome-printed PDFs) are document-wide objects, so pages that reuse such a font no longer render blank.
   PDF.js versions after 3.1.81 already have this; check that a new version does before dropping it.
1. Check that the fzf-style finder (lib/fzf.js) still works: it uses `PDFViewerApplication.findBar`
   (`opened`, `bar`, `findField`, `open()`, `close()`, `dispatchEvent()`) and the text layer's `textDivs`/`textContentItemsStr`.

## Change log
See [CHANGELOG.md](CHANGELOG.md).

## License
Please see [LICENSE](./LICENSE)
