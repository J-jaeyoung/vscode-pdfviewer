import * as vscode from 'vscode';
import { HighlightStore } from './highlights';
import { PdfCustomProvider } from './pdfProvider';

export function activate(context: vscode.ExtensionContext): void {
  const extensionRoot = vscode.Uri.file(context.extensionPath);
  const highlights = new HighlightStore(context.globalState);
  context.subscriptions.push(highlights);

  // Register our custom editor provider
  const provider = new PdfCustomProvider(extensionRoot, highlights);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfCustomProvider.viewType,
      provider,
      {
        webviewOptions: {
          enableFindWidget: false, // default
          retainContextWhenHidden: true,
        },
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pdf-preview.toggleHighlight', () => {
      const preview = provider.activePreview;
      if (!preview) {
        vscode.window.showInformationMessage('No active PDF preview.');
        return;
      }
      preview.toggleHighlight();
    }),
    vscode.commands.registerCommand('pdf-preview.clearHighlights', async () => {
      const preview = provider.activePreview;
      if (!preview) {
        vscode.window.showInformationMessage('No active PDF preview.');
        return;
      }
      const count = highlights.get(preview.resource).length;
      if (count === 0) {
        vscode.window.showInformationMessage('This PDF has no highlights.');
        return;
      }
      const remove = 'Remove';
      const answer = await vscode.window.showWarningMessage(
        `Remove all ${count} highlight(s) in this PDF?`,
        { modal: true },
        remove
      );
      if (answer === remove) {
        await highlights.set(preview.resource, []);
      }
    })
  );
}

export function deactivate(): void {}
