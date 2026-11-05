import * as vscode from 'vscode';

/**
 * A highlight on one page. `rects` are in PDF user space
 * ([x1, y1, x2, y2], normalized), so they are independent of zoom and rotation.
 */
export interface Highlight {
  id: string;
  page: number;
  rects: number[][];
  text?: string;
  createdAt?: number;
}

export interface HighlightsChangeEvent {
  resource: vscode.Uri;
  highlights: Highlight[];
  /** Opaque token identifying who made the change, so they can skip the echo. */
  origin?: unknown;
}

function isHighlight(value: unknown): value is Highlight {
  const h = value as Highlight;
  return (
    !!h &&
    typeof h.id === 'string' &&
    Number.isInteger(h.page) &&
    h.page > 0 &&
    Array.isArray(h.rects) &&
    h.rects.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
  );
}

/**
 * Persists highlights per PDF (keyed by URI) in the extension's global state.
 * The PDF file itself is never modified.
 */
export class HighlightStore {
  private readonly _onDidChange = new vscode.EventEmitter<
    HighlightsChangeEvent
  >();
  public readonly onDidChange = this._onDidChange.event;

  constructor(private readonly memento: vscode.Memento) {}

  private key(resource: vscode.Uri): string {
    return `highlights:${resource.toString()}`;
  }

  public get(resource: vscode.Uri): Highlight[] {
    return this.memento.get<Highlight[]>(this.key(resource), []);
  }

  public async set(
    resource: vscode.Uri,
    highlights: Highlight[],
    origin?: unknown
  ): Promise<void> {
    const sanitized = Array.isArray(highlights)
      ? highlights.filter(isHighlight)
      : [];
    await this.memento.update(
      this.key(resource),
      sanitized.length > 0 ? sanitized : undefined
    );
    this._onDidChange.fire({ resource, highlights: sanitized, origin });
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}
