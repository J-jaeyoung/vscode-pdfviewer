// fzf-style line finder for the PDF viewer.
// In the find bar, press Ctrl/Cmd+F again to switch to it; press it once more
// to go back to the normal find bar. Lines are ranked with fzf's scoring, but
// matching is stricter than fzf's: terms in order, letters in word-start chunks.
(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Matching. Scores follow fzf (github.com/junegunn/fzf, src/algo/algo.go).
  // ---------------------------------------------------------------------------
  const SCORE_MATCH = 16
  const SCORE_GAP_START = -3
  const SCORE_GAP_EXTENSION = -1
  const BONUS_BOUNDARY = SCORE_MATCH / 2
  const BONUS_NON_WORD = SCORE_MATCH / 2
  const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION
  const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION)
  const BONUS_FIRST_CHAR_MULTIPLIER = 2
  const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2
  const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1

  const WHITE = 0
  const NON_WORD = 1
  const DELIMITER = 2
  const LOWER = 3
  const UPPER = 4
  const LETTER = 5
  const NUMBER = 6
  const DELIMITERS = '/,:;|'

  function charClass(c) {
    const code = c.charCodeAt(0)
    if (code < 128) {
      if (code >= 97 && code <= 122) return LOWER
      if (code >= 65 && code <= 90) return UPPER
      if (code >= 48 && code <= 57) return NUMBER
      if (code === 32 || (code >= 9 && code <= 13)) return WHITE
      return DELIMITERS.indexOf(c) !== -1 ? DELIMITER : NON_WORD
    }
    if (/\s/u.test(c)) return WHITE
    if (/\p{Ll}/u.test(c)) return LOWER
    if (/\p{Lu}/u.test(c)) return UPPER
    if (/\p{N}/u.test(c)) return NUMBER
    if (/\p{L}/u.test(c)) return LETTER
    return NON_WORD
  }

  function bonusFor(prev, cls) {
    if (cls > NON_WORD) {
      if (prev === WHITE) return BONUS_BOUNDARY_WHITE
      if (prev === DELIMITER) return BONUS_BOUNDARY_DELIMITER
      if (prev === NON_WORD) return BONUS_BOUNDARY
    }
    if ((prev === LOWER && cls === UPPER) || (prev !== NUMBER && cls === NUMBER)) {
      return BONUS_CAMEL_123
    }
    if (cls === NON_WORD || cls === DELIMITER) return BONUS_NON_WORD
    if (cls === WHITE) return BONUS_BOUNDARY_WHITE
    return 0
  }

  // Like fzf: ligatures and Latin diacritics are normalized ("ﬁ" -> "fi",
  // "é" -> "e"). Hangul is left alone so syllables are not split into jamo.
  const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/
  function foldChar(ch) {
    if (ch.length === 1 && ch.charCodeAt(0) < 128) return ch
    if (HANGUL.test(ch)) return ch
    return ch.normalize('NFKD').replace(/\p{M}/gu, '')
  }

  function lowerUnit(c) {
    const l = c.toLowerCase()
    return l.length === 1 ? l : c
  }

  // Folded forms of `text`; map[k] is the index in `text` of folded unit k.
  function prepare(text) {
    let fold = ''
    let lower = ''
    const map = []
    let i = 0
    for (const ch of text) {
      const f = foldChar(ch)
      for (let k = 0; k < f.length; k++) {
        fold += f[k]
        lower += lowerUnit(f[k])
        map.push(i)
      }
      i += ch.length
    }
    const bonus = new Int8Array(fold.length)
    // ws[k]: a letter or digit that starts a word (or a camelCase hump).
    const ws = new Uint8Array(fold.length)
    let prev = WHITE
    for (let k = 0; k < fold.length; k++) {
      const cls = charClass(fold[k])
      bonus[k] = bonusFor(prev, cls)
      ws[k] = cls >= LOWER && bonus[k] >= BONUS_CAMEL_123 ? 1 : 0
      prev = cls
    }
    return { text, fold, lower, map, bonus, ws }
  }

  const NEG = -1000000000
  const CHUNK = 0
  const CONTIG = 1
  let bufSize = 0
  let S0, S1, M, F0, F1, FS0, FS1, MS, FB0, FB1
  function ensure(size) {
    if (size > bufSize) {
      bufSize = Math.max(size, bufSize * 2, 4096)
      S0 = new Int32Array(bufSize)
      S1 = new Int32Array(bufSize)
      M = new Int32Array(bufSize)
      F0 = new Int32Array(bufSize)
      F1 = new Int32Array(bufSize)
      FS0 = new Uint8Array(bufSize)
      FS1 = new Uint8Array(bufSize)
      MS = new Uint8Array(bufSize)
      FB0 = new Int8Array(bufSize)
      FB1 = new Int8Array(bufSize)
    }
  }

  // Bonus for a character continuing a run whose first character had `first`.
  function consecutive(b, first) {
    if (b >= BONUS_BOUNDARY && b > first) return [b, b]
    return [Math.max(b, first, BONUS_CONSECUTIVE), first]
  }

  // Best-scoring alignment of the query terms, in order, using fzf's scores.
  // A term matches either as chunks of consecutive letters that each start at
  // a word boundary (word start, camelCase hump, after "-", digits; e.g.
  // "dcred" -> "DirtyCred", "privesc" -> "privilege escalation") in adjacent
  // words, or as one contiguous substring anywhere (exact terms: only this way).
  // `pat` comes from compile(). Returns { score, positions } or null.
  function match(fold, lower, bonus, ws, pat) {
    const n = fold.length
    const m = pat.codes.length
    let idx = 0
    for (let i = 0; i < m; i++) {
      idx = lower.indexOf(pat.lowerChars[i], idx)
      if (idx < 0) return null
      idx++
    }
    ensure(m * n)
    for (let i = 0; i < m; i++) {
      const code = pat.codes[i]
      const text = pat.caseSensitive[i] ? fold : lower
      const isStart = pat.start[i] === 1
      const chunkOk = pat.chunkOk[i] === 1
      const contigOk = pat.contigOk[i] === 1
      const row = i * n
      const prow = row - n
      // Running maxima over cells at least two characters back, gap included:
      // any state (for a new term) and chunk state (for a new chunk).
      let gBest = NEG
      let gArg = -1
      let cBest = NEG
      let cArg = -1
      for (let j = 0; j < n; j++) {
        if (i > 0 && j >= 2) {
          if (gBest > NEG) gBest += SCORE_GAP_EXTENSION
          const v = M[prow + j - 2]
          if (v > NEG && v >= gBest) {
            gBest = v
            gArg = j - 2
          }
          if (ws[j - 1]) {
            // A chunk may not skip a word: nothing before j - 1 is reachable.
            cBest = NEG
          } else {
            if (cBest > NEG) cBest += SCORE_GAP_EXTENSION
            const w = S0[prow + j - 2]
            if (w > NEG && w >= cBest) {
              cBest = w
              cArg = j - 2
            }
          }
        }
        const k = row + j
        S0[k] = NEG
        S1[k] = NEG
        M[k] = NEG
        if (text.charCodeAt(j) !== code) continue
        const b = bonus[j]
        const boundary = b >= BONUS_CAMEL_123
        if (isStart) {
          let prev = 0
          let fk = -1
          let fs = 0
          if (i > 0) {
            prev = NEG
            if (j >= 1 && M[prow + j - 1] > NEG) {
              prev = M[prow + j - 1]
              fk = j - 1
            }
            if (gBest > NEG && gBest + SCORE_GAP_START > prev) {
              prev = gBest + SCORE_GAP_START
              fk = gArg
            }
            if (prev === NEG) continue
            fs = MS[prow + fk]
          }
          const score = prev + SCORE_MATCH + (i === 0 ? b * BONUS_FIRST_CHAR_MULTIPLIER : b)
          if (chunkOk && boundary) {
            S0[k] = score
            F0[k] = fk
            FS0[k] = fs
            FB0[k] = b
          }
          if (contigOk) {
            S1[k] = score
            F1[k] = fk
            FS1[k] = fs
            FB1[k] = b
          }
        } else if (j >= 1) {
          const d0 = S0[prow + j - 1]
          if (d0 > NEG) {
            const [add, first] = consecutive(b, FB0[prow + j - 1])
            S0[k] = d0 + SCORE_MATCH + add
            F0[k] = j - 1
            FS0[k] = CHUNK
            FB0[k] = first
          }
          if (boundary && cBest > NEG) {
            const s = cBest + SCORE_GAP_START + SCORE_MATCH + b
            if (s > S0[k]) {
              S0[k] = s
              F0[k] = cArg
              FS0[k] = CHUNK
              FB0[k] = b
            }
          }
          const d1 = S1[prow + j - 1]
          if (d1 > NEG) {
            const [add, first] = consecutive(b, FB1[prow + j - 1])
            S1[k] = d1 + SCORE_MATCH + add
            F1[k] = j - 1
            FS1[k] = CONTIG
            FB1[k] = first
          }
        }
        if (S0[k] >= S1[k]) {
          M[k] = S0[k]
          MS[k] = CHUNK
        } else {
          M[k] = S1[k]
          MS[k] = CONTIG
        }
      }
    }
    const last = (m - 1) * n
    let score = NEG
    let end = -1
    for (let j = 0; j < n; j++) {
      if (M[last + j] > score) {
        score = M[last + j]
        end = j
      }
    }
    if (end < 0) return null
    const positions = new Array(m)
    let state = MS[last + end]
    positions[m - 1] = end
    for (let i = m - 1; i > 0; i--) {
      const k = i * n + end
      const from = state === CHUNK ? F0[k] : F1[k]
      state = state === CHUNK ? FS0[k] : FS1[k]
      end = from
      positions[i - 1] = end
    }
    return { score, positions }
  }

  // Query syntax: space-separated terms must appear in this order;
  // 'term = exact substring, !term = exclude lines containing term (any
  // position). Smart case: a term with an uppercase letter is case-sensitive.
  function parseQuery(query) {
    const terms = []
    for (let token of query.split(/\s+/)) {
      let negate = false
      let exact = false
      if (token.length > 1 && token[0] === '!') {
        negate = true
        token = token.slice(1)
      }
      if (token.length > 1 && token[0] === "'") {
        exact = true
        token = token.slice(1)
      }
      const p = prepare(token)
      if (!p.fold) continue
      const caseSensitive = /\p{Lu}/u.test(p.fold)
      terms.push({ negate, exact: exact || negate, caseSensitive, text: caseSensitive ? p.fold : p.lower })
    }
    return terms
  }

  // The positive terms as one ordered pattern.
  function compile(terms) {
    const codes = []
    const lowerChars = []
    const caseSensitive = []
    const start = []
    const chunkOk = []
    const contigOk = []
    for (const t of terms) {
      for (let k = 0; k < t.text.length; k++) {
        codes.push(t.text.charCodeAt(k))
        lowerChars.push(lowerUnit(t.text[k]))
        caseSensitive.push(t.caseSensitive ? 1 : 0)
        start.push(k === 0 ? 1 : 0)
        chunkOk.push(t.exact ? 0 : 1)
        // A single letter anywhere would match almost every line.
        contigOk.push(t.exact || t.text.length >= 2 ? 1 : 0)
      }
    }
    return { codes, lowerChars, caseSensitive, start: Uint8Array.from(start), chunkOk: Uint8Array.from(chunkOk), contigOk: Uint8Array.from(contigOk) }
  }

  // A candidate is a line plus the next line on the same page, so a phrase
  // that wraps still matches; only matches that start on the line count.
  function makeWindow(line, next) {
    if (!next) {
      return { fold: line.fold, lower: line.lower, bonus: line.bonus, ws: line.ws, split: line.fold.length }
    }
    const split = line.fold.length
    const bonus = new Int8Array(split + 1 + next.fold.length)
    bonus.set(line.bonus, 0)
    bonus[split] = bonusFor(split ? charClass(line.fold[split - 1]) : WHITE, WHITE)
    bonus.set(next.bonus, split + 1)
    const ws = new Uint8Array(bonus.length)
    ws.set(line.ws, 0)
    ws.set(next.ws, split + 1)
    return { fold: line.fold + ' ' + next.fold, lower: line.lower + ' ' + next.lower, bonus, ws, split }
  }

  // Returns [{ index, score, positions }] best first (document order on ties).
  function search(lines, windows, query) {
    const terms = parseQuery(query)
    const positive = terms.filter((t) => !t.negate)
    const negative = terms.filter((t) => t.negate)
    const pat = compile(positive)
    const results = []
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]
      const line = lines[i]
      let ok = true
      for (const t of negative) {
        if ((t.caseSensitive ? line.fold : line.lower).indexOf(t.text) !== -1) {
          ok = false
          break
        }
      }
      if (!ok) continue
      if (!positive.length) {
        results.push({ index: i, score: 0, positions: [] })
        continue
      }
      const r = match(w.fold, w.lower, w.bonus, w.ws, pat)
      if (!r || r.positions[0] >= w.split) continue
      results.push({ index: i, score: r.score, positions: r.positions })
    }
    results.sort((a, b) => b.score - a.score || a.index - b.index)
    return results
  }

  const matcher = { prepare, makeWindow, search, parseQuery, compile, match, BONUS_CAMEL_123 }
  if (typeof module === 'object' && module.exports) {
    module.exports = matcher
  }
  if (typeof window === 'undefined' || !window.PDFViewerApplication) {
    return
  }

  // ---------------------------------------------------------------------------
  // Text extraction: lines of every page, with offsets in the text layer.
  // ---------------------------------------------------------------------------
  let corpus = null

  function extract(pdfDocument, onProgress) {
    const c = { pdfDocument, lines: [], windows: [], pagesDone: 0, numPages: pdfDocument.numPages, done: false }
    corpus = c
    ;(async () => {
      for (let p = 1; p <= c.numPages; p++) {
        if (corpus !== c) return
        let items = []
        try {
          const page = await pdfDocument.getPage(p)
          items = (await page.getTextContent()).items
        } catch (err) {
          console.error(err)
        }
        const pageLines = []
        let offset = 0
        let cur = null
        const flush = () => {
          if (cur && cur.text.trim()) {
            pageLines.push(Object.assign(prepare(cur.text), { page: p, start: cur.start, top: cur.top }))
          }
          cur = null
        }
        for (const item of items) {
          if (typeof item.str !== 'string') continue
          if (!cur) cur = { text: '', start: offset, top: null }
          if (cur.top === null && item.str.trim() && item.transform) {
            cur.top = item.transform[5] + (item.height || 0)
          }
          cur.text += item.str
          offset += item.str.length
          if (item.hasEOL) flush()
        }
        flush()
        for (let k = 0; k < pageLines.length; k++) {
          c.lines.push(pageLines[k])
          c.windows.push(makeWindow(pageLines[k], pageLines[k + 1]))
        }
        c.pagesDone = p
        onProgress(c)
      }
      c.done = true
      onProgress(c)
    })()
    return c
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  const MAX_ROWS = 300
  const app = window.PDFViewerApplication
  let panel = null
  let input = null
  let list = null
  let count = null
  let results = []
  let selected = 0
  let lastQuery = null
  let renderQueued = false

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  function build() {
    panel = el('div', 'vscode-pdf-fzf')
    panel.hidden = true
    const bar = el('div', 'vscode-pdf-fzf-bar')
    bar.append(el('span', 'vscode-pdf-fzf-prompt', '>'))
    input = el('input', 'vscode-pdf-fzf-input')
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = "words in order · dcred → DirtyCred · 'exact · !exclude"
    bar.append(input)
    count = el('span', 'vscode-pdf-fzf-count')
    bar.append(count)
    list = el('div', 'vscode-pdf-fzf-list')
    list.setAttribute('role', 'listbox')
    const hint = el('div', 'vscode-pdf-fzf-hint', '↑↓ select · Enter go · Ctrl+F normal find · Esc close')
    panel.append(bar, list, hint)
    ;(document.getElementById('mainContainer') || document.body).append(panel)

    input.addEventListener('input', guard(() => schedule()))
    input.addEventListener('keydown', guard(onKeyDown))
    panel.addEventListener('focusout', guard((e) => {
      if (!panel.contains(e.relatedTarget)) close(false)
    }))
    // Keep the focus in the input while clicking rows.
    list.addEventListener('mousedown', (e) => e.preventDefault())
    list.addEventListener('click', guard((e) => {
      const row = e.target.closest('.vscode-pdf-fzf-row')
      if (row) {
        selected = Number(row.dataset.i)
        go()
      }
    }))
  }

  function guard(fn) {
    return function (...args) {
      try {
        return fn.apply(this, args)
      } catch (err) {
        console.error(err)
      }
    }
  }

  function isOpen() {
    return !!panel && !panel.hidden
  }

  function open(query) {
    if (!panel) build()
    const findBar = app.findBar
    if (findBar && findBar.opened) findBar.close()
    if (!corpus || corpus.pdfDocument !== app.pdfDocument) {
      lastQuery = null
      if (app.pdfDocument) extract(app.pdfDocument, () => schedule())
    }
    panel.hidden = false
    if (query !== lastQuery) {
      selected = 0
    }
    input.value = query
    input.focus()
    input.setSelectionRange(query.length, query.length)
    render()
  }

  function close(focusViewer) {
    if (!isOpen()) return
    lastQuery = input.value
    panel.hidden = true
    // Ctrl+F, Ctrl+F later brings back this query (and the selected line).
    if (app.findBar) app.findBar.findField.value = input.value
    if (focusViewer) {
      const container = document.getElementById('viewerContainer')
      if (container) container.focus()
    }
  }

  function backToFindBar() {
    const query = input.value
    close(false)
    const findBar = app.findBar
    findBar.open()
    findBar.findField.value = query
    findBar.findField.select()
    if (query) findBar.dispatchEvent('')
  }

  function schedule() {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(guard(() => {
      renderQueued = false
      if (isOpen()) render()
    }))
  }

  function render() {
    const c = corpus
    const lines = c ? c.lines : []
    if (input.value !== lastQuery) {
      lastQuery = input.value
      selected = 0
    }
    results = c ? search(c.lines, c.windows, input.value) : []
    selected = Math.max(0, Math.min(selected, results.length - 1))
    count.textContent = `${results.length}/${lines.length}` +
      (c && !c.done ? ` · reading p.${c.pagesDone}/${c.numPages}` : '')
    list.textContent = ''
    const shown = Math.min(results.length, MAX_ROWS)
    for (let r = 0; r < shown; r++) {
      list.append(row(results[r], r))
    }
    if (results.length > shown) {
      list.append(el('div', 'vscode-pdf-fzf-more', `… ${results.length - shown} more`))
    }
    highlightSelected()
  }

  // Display text and the character indexes to emphasize.
  function display(result) {
    const lines = corpus.lines
    const line = lines[result.index]
    const w = corpus.windows[result.index]
    const next = w.split < w.fold.length ? lines[result.index + 1] : null
    const marks = new Set()
    let spills = false
    for (const p of result.positions) {
      if (p < w.split) {
        marks.add(line.map[p])
      } else if (next && p > w.split) {
        marks.add(line.text.length + 1 + next.map[p - w.split - 1])
        spills = true
      }
    }
    const text = spills ? line.text + ' ' + next.text : line.text
    return { text, marks }
  }

  function row(result, r) {
    const d = el('div', 'vscode-pdf-fzf-row')
    d.dataset.i = String(r)
    d.setAttribute('role', 'option')
    const { text, marks } = display(result)
    const t = el('span', 'vscode-pdf-fzf-text')
    const first = marks.size ? Math.min(...marks) : 0
    let from = 0
    if (first > 40) {
      from = first - 20
      t.append('…')
    }
    let plain = ''
    for (let k = from; k < text.length; k++) {
      if (marks.has(k)) {
        if (plain) t.append(plain)
        plain = ''
        t.append(el('b', null, text[k]))
      } else {
        plain += text[k]
      }
    }
    if (plain) t.append(plain)
    d.append(t, el('span', 'vscode-pdf-fzf-page', `p.${corpus.lines[result.index].page}`))
    return d
  }

  function highlightSelected() {
    for (const e of list.querySelectorAll('.vscode-pdf-fzf-row.selected')) e.classList.remove('selected')
    const cur = list.children[selected]
    if (cur && cur.classList.contains('vscode-pdf-fzf-row')) {
      cur.classList.add('selected')
      cur.setAttribute('aria-selected', 'true')
      cur.scrollIntoView({ block: 'nearest' })
    }
  }

  function move(delta) {
    const shown = Math.min(results.length, MAX_ROWS)
    if (!shown) return
    selected = Math.max(0, Math.min(shown - 1, selected + delta))
    highlightSelected()
  }

  function onKeyDown(e) {
    if (e.isComposing) return
    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'PageDown':
        move(10)
        break
      case 'PageUp':
        move(-10)
        break
      case 'Enter':
        go()
        break
      case 'Escape':
        close(true)
        break
      default:
        handled = false
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // Offsets (in the page's text layer string) spanned by a result, widened
  // to whole words.
  function span(result) {
    const lines = corpus.lines
    const line = lines[result.index]
    const w = corpus.windows[result.index]
    const next = w.split < w.fold.length ? lines[result.index + 1] : null
    const at = (p) => (p < w.split
      ? { line, i: line.map[p] }
      : { line: next, i: next.map[p - w.split - 1] })
    const ps = result.positions.filter((p) => p !== w.split)
    if (!ps.length) {
      return { page: line.page, start: line.start, end: line.start + line.text.length, top: line.top }
    }
    const a = at(Math.min(...ps))
    const b = at(Math.max(...ps))
    const word = /[\p{L}\p{N}]/u
    let s = a.i
    while (s > 0 && word.test(a.line.text[s - 1]) && word.test(a.line.text[s])) s--
    let e = b.i + 1
    while (e < b.line.text.length && word.test(b.line.text[e]) && word.test(b.line.text[e - 1])) e++
    return { page: line.page, start: a.line.start + s, end: b.line.start + e, top: line.top }
  }

  function go() {
    const result = results[selected]
    if (!result) return
    const hit = span(result)
    close(true)
    const viewer = app.pdfViewer
    const pageView = viewer.getPageView(hit.page - 1)
    const pageTop = pageView ? pageView.viewport.viewBox[3] : null
    if (hit.top !== null) {
      viewer.scrollPageIntoView({
        pageNumber: hit.page,
        destArray: [null, { name: 'XYZ' }, null, pageTop === null ? hit.top : Math.min(pageTop, hit.top + 60), null],
        allowNegativeOffset: true,
      })
    } else {
      viewer.scrollPageIntoView({ pageNumber: hit.page })
    }
    whenTextLayer(hit.page, () => flash(hit))
  }

  function whenTextLayer(pageNumber, fn) {
    const pageView = app.pdfViewer.getPageView(pageNumber - 1)
    if (pageView && pageView.textLayer && pageView.textLayer.renderingDone) {
      requestAnimationFrame(guard(fn))
      return
    }
    const bus = app.eventBus
    const onRendered = guard((e) => {
      if (e.pageNumber !== pageNumber) return
      bus.off('textlayerrendered', onRendered)
      clearTimeout(timer)
      requestAnimationFrame(guard(fn))
    })
    const timer = setTimeout(() => bus.off('textlayerrendered', onRendered), 10000)
    bus.on('textlayerrendered', onRendered)
  }

  // DOM position of a text layer offset.
  function point(textLayer, offset, isEnd) {
    const strs = textLayer.textContentItemsStr
    let acc = 0
    for (let k = 0; k < strs.length; k++) {
      const len = strs[k].length
      if (len && (isEnd ? offset <= acc + len : offset < acc + len)) {
        let rest = offset - acc
        const walker = document.createTreeWalker(textLayer.textDivs[k], NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          if (isEnd ? rest <= node.length : rest < node.length) return [node, rest]
          rest -= node.length
          const nextNode = walker.nextNode()
          if (!nextNode) return [node, node.length]
          node = nextNode
        }
        return null
      }
      acc += len
    }
    return null
  }

  function flash(hit) {
    const pageView = app.pdfViewer.getPageView(hit.page - 1)
    const textLayer = pageView && pageView.textLayer
    if (!textLayer) return
    const a = point(textLayer, hit.start, false)
    const b = point(textLayer, hit.end, true)
    if (!a || !b) return
    const range = document.createRange()
    range.setStart(a[0], a[1])
    range.setEnd(b[0], b[1])
    const pageDiv = pageView.div
    for (const old of document.querySelectorAll('.vscode-pdf-fzf-layer')) old.remove()
    const layer = el('div', 'vscode-pdf-fzf-layer')
    const box = pageDiv.getBoundingClientRect()
    const left = box.left + pageDiv.clientLeft
    const top = box.top + pageDiv.clientTop
    // Rects of the text nodes only (a range's own rects add element boxes too).
    const rects = []
    const common = range.commonAncestorContainer
    const root = common.nodeType === Node.TEXT_NODE ? common.parentNode : common
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue
      const sub = document.createRange()
      sub.selectNodeContents(node)
      if (node === range.startContainer) sub.setStart(node, range.startOffset)
      if (node === range.endContainer) sub.setEnd(node, range.endOffset)
      for (const r of sub.getClientRects()) rects.push(r)
    }
    let firstHit = null
    for (const r of rects) {
      if (r.width < 0.5 || r.height < 0.5) continue
      const d = el('div', 'vscode-pdf-fzf-hit')
      d.style.left = `${r.left - left - 1}px`
      d.style.top = `${r.top - top - 1}px`
      d.style.width = `${r.width + 2}px`
      d.style.height = `${r.height + 2}px`
      layer.append(d)
      firstHit = firstHit || d
    }
    pageDiv.insertBefore(layer, pageDiv.querySelector('.textLayer'))
    if (firstHit) {
      const view = document.getElementById('viewerContainer').getBoundingClientRect()
      const h = firstHit.getBoundingClientRect()
      if (h.top < view.top || h.bottom > view.bottom) {
        firstHit.scrollIntoView({ block: 'center' })
      }
    }
    setTimeout(() => layer.remove(), 2500)
  }

  // Ctrl/Cmd+F in the find bar opens the fzf finder; in the finder it goes back.
  window.addEventListener('keydown', guard((e) => {
    if (e.keyCode !== 70 || e.shiftKey || e.altKey || e.ctrlKey === e.metaKey) return
    const active = document.activeElement
    if (isOpen() && panel.contains(active)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      backToFindBar()
      return
    }
    const findBar = app.findBar
    if (findBar && findBar.opened && findBar.bar.contains(active)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      open(findBar.findField.value)
    }
  }), true)

  window.vscodePdfFzf = { open, close, isOpen }
}())
