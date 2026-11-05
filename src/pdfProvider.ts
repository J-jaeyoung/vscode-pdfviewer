import * as vscode from 'vscode';
import { HighlightStore } from './highlights';
import { PdfPreview } from './pdfPreview';

export class PdfCustomProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'pdf.preview';

  private readonly _previews = new Set<PdfPreview>();
  private _activePreview: PdfPreview | undefined;

  private readonly _onDidChangePreviews = new vscode.EventEmitter<void>();
  /** Fires when a preview is opened or closed. */
  public readonly onDidChangePreviews = this._onDidChangePreviews.event;

  constructor(
    private readonly extensionRoot: vscode.Uri,
    private readonly highlights: HighlightStore
  ) {}

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: (): void => {} };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewEditor: vscode.WebviewPanel
  ): Promise<void> {
    const preview = new PdfPreview(
      this.extensionRoot,
      document.uri,
      webviewEditor,
      this.highlights
    );
    this._previews.add(preview);
    this.setActivePreview(preview);
    this._onDidChangePreviews.fire();

    webviewEditor.onDidDispose(() => {
      preview.dispose();
      this._previews.delete(preview);
      if (this._activePreview === preview) {
        this.setActivePreview(undefined);
      }
      this._onDidChangePreviews.fire();
    });

    webviewEditor.onDidChangeViewState(() => {
      if (webviewEditor.active) {
        this.setActivePreview(preview);
      } else if (this._activePreview === preview && !webviewEditor.active) {
        this.setActivePreview(undefined);
      }
    });
  }

  public get activePreview(): PdfPreview {
    return this._activePreview;
  }

  /** An open preview of `resource`, preferring the active one. */
  public findPreview(resource: vscode.Uri): PdfPreview | undefined {
    const key = resource.toString();
    if (
      this._activePreview &&
      this._activePreview.resource.toString() === key
    ) {
      return this._activePreview;
    }
    for (const preview of this._previews) {
      if (preview.resource.toString() === key) {
        return preview;
      }
    }
    return undefined;
  }

  private setActivePreview(value: PdfPreview | undefined): void {
    this._activePreview = value;
  }
}
