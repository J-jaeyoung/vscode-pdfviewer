import * as vscode from 'vscode';
import { CommentsViewProvider, REVEAL_COMMAND } from './commentsView';
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

  // "PDF Comments" view in the Explorer.
  const commentsView = new CommentsViewProvider(
    highlights,
    (resource) => !!provider.findPreview(resource)
  );
  context.subscriptions.push(
    commentsView,
    vscode.window.registerTreeDataProvider(
      'pdf-preview.comments',
      commentsView
    ),
    highlights.onDidChange(() => commentsView.refresh()),
    provider.onDidChangePreviews(() => commentsView.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => commentsView.refresh()),
    vscode.commands.registerCommand(
      REVEAL_COMMAND,
      async (resource: string, id: string) => {
        const uri = vscode.Uri.parse(resource);
        if (!provider.findPreview(uri)) {
          await vscode.commands.executeCommand(
            'vscode.openWith',
            uri,
            PdfCustomProvider.viewType
          );
        }
        const preview = provider.findPreview(uri);
        if (preview) {
          preview.revealHighlight(id);
        }
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
    vscode.commands.registerCommand('pdf-preview.commentHighlight', () => {
      const preview = provider.activePreview;
      if (!preview) {
        vscode.window.showInformationMessage('No active PDF preview.');
        return;
      }
      preview.commentHighlight();
    }),
    vscode.commands.registerCommand('pdf-preview.clearHighlights', async () => {
      const preview = provider.activePreview;
      if (!preview) {
        vscode.window.showInformationMessage('No active PDF preview.');
        return;
      }
      const list = highlights.get(preview.resource);
      const count = list.length;
      const comments = list.filter((h) => h.comment).length;
      if (count === 0) {
        vscode.window.showInformationMessage('This PDF has no highlights.');
        return;
      }
      const remove = 'Remove';
      const answer = await vscode.window.showWarningMessage(
        `Remove all ${count} highlight(s) in this PDF?` +
          (comments ? ` ${comments} of them have comments.` : ''),
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
