import * as path from 'path';
import * as vscode from 'vscode';
import { Highlight, HighlightStore } from './highlights';

export const REVEAL_COMMAND = 'pdf-preview.revealHighlight';

interface FileNode {
  kind: 'file';
  resource: vscode.Uri;
  comments: Highlight[];
}

interface CommentNode {
  kind: 'comment';
  resource: vscode.Uri;
  highlight: Highlight;
}

type Node = FileNode | CommentNode;

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Top edge of a highlight in PDF space (y grows upwards).
function top(h: Highlight): number {
  return Math.max(...h.rects.map((r) => r[3]));
}

/**
 * "PDF Comments" view: commented highlights grouped by PDF, in page order.
 * Shows PDFs in the open workspace folders, plus any PDF currently open.
 */
export class CommentsViewProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    Node | undefined
  >();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: HighlightStore,
    private readonly isOpen: (resource: vscode.Uri) => boolean
  ) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public getChildren(node?: Node): Node[] {
    if (!node) {
      return this.store
        .resources()
        .filter(
          (r) => !!vscode.workspace.getWorkspaceFolder(r) || this.isOpen(r)
        )
        .map(
          (resource): FileNode => ({
            kind: 'file',
            resource,
            comments: this.store
              .get(resource)
              .filter((h) => h.comment)
              .sort((a, b) => a.page - b.page || top(b) - top(a)),
          })
        )
        .filter((f) => f.comments.length > 0)
        .sort((a, b) =>
          path.posix
            .basename(a.resource.path)
            .localeCompare(path.posix.basename(b.resource.path))
        );
    }
    if (node.kind === 'file') {
      return node.comments.map(
        (highlight): CommentNode => ({
          kind: 'comment',
          resource: node.resource,
          highlight,
        })
      );
    }
    return [];
  }

  public getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(
        path.posix.basename(node.resource.path),
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.resourceUri = node.resource;
      item.description = `${node.comments.length}`;
      item.tooltip = node.resource.fsPath;
      return item;
    }
    const h = node.highlight;
    const item = new vscode.TreeItem(
      oneLine(h.comment || '', 80),
      vscode.TreeItemCollapsibleState.None
    );
    item.description =
      `p.${h.page}` + (h.text ? ` · ${oneLine(h.text, 40)}` : '');
    item.tooltip = `${h.comment}\n\n"${oneLine(h.text || '', 300)}" (p.${
      h.page
    })`;
    item.iconPath = new vscode.ThemeIcon('comment');
    item.command = {
      command: REVEAL_COMMAND,
      title: 'Go to Comment',
      arguments: [node.resource.toString(), h.id],
    };
    return item;
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
