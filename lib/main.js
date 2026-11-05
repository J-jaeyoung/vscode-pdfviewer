"use strict";

(function () {
  function loadConfig() {
    const elem = document.getElementById('pdf-preview-config')
    if (elem) {
      return JSON.parse(elem.getAttribute('data-config'))
    }
    throw new Error('Could not load configuration.')
  }
  function cursorTools(name) {
    if (name === 'hand') {
      return 1
    }
    return 0
  }
  function scrollMode(name) {
    switch (name) {
      case 'vertical':
        return 0
      case 'horizontal':
        return 1
      case 'wrapped':
        return 2
      default:
        return -1
    }
  }
  function spreadMode(name) {
    switch (name) {
      case 'none':
        return 0
      case 'odd':
        return 1
      case 'even':
        return 2
      default:
        return -1
    }
  }
  const vscodeApi = acquireVsCodeApi()

  // ---------------------------------------------------------------------------
  // Highlights
  //
  // Highlights are stored by the extension (not in the PDF file). Each one is
  // { id, page, rects, text } where rects are [x1, y1, x2, y2] in PDF user
  // space, so they survive zooming, rotation and reloads.
  // ---------------------------------------------------------------------------
  const highlighter = (function () {
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const LAYER_CLASS = 'vscode-pdf-highlights'
    const COMMENT_LAYER_CLASS = 'vscode-pdf-comments'
    let highlights = []
    let ready = false
    let updatedBeforeInit = false
    let pendingReveal = null
    let pagesLoaded = false
    let flash = null // { id, until }: briefly emphasize a revealed highlight

    function notify(message) {
      vscodeApi.postMessage({ type: 'notify', message })
    }

    function round(n) {
      return Math.round(n * 100) / 100
    }

    function normalize(r) {
      return [
        Math.min(r[0], r[2]), Math.min(r[1], r[3]),
        Math.max(r[0], r[2]), Math.max(r[1], r[3]),
      ]
    }

    function overlap(a1, a2, b1, b2) {
      return Math.min(a2, b2) - Math.max(a1, b1)
    }

    // Two boxes on the same text line that touch or overlap.
    function sameLine(a, b) {
      const minHeight = Math.min(a[3] - a[1], b[3] - b[1])
      return overlap(a[1], a[3], b[1], b[3]) >= 0.5 * minHeight &&
        overlap(a[0], a[2], b[0], b[2]) >= -0.5 * minHeight
    }

    // Joins per-span boxes into one box per line (fills word gaps).
    function mergeRects(rects) {
      let merged = rects
      let changed = true
      while (changed) {
        changed = false
        const out = []
        for (const r of merged) {
          const target = out.find((o) => sameLine(o, r))
          if (target) {
            target[0] = Math.min(target[0], r[0])
            target[1] = Math.min(target[1], r[1])
            target[2] = Math.max(target[2], r[2])
            target[3] = Math.max(target[3], r[3])
            changed = true
          } else {
            out.push(r.slice())
          }
        }
        merged = out
      }
      return merged.map((r) => r.map(round))
    }

    function intersects(a, b) {
      const w = overlap(a[0], a[2], b[0], b[2])
      const h = overlap(a[1], a[3], b[1], b[3])
      if (w <= 0 || h <= 0) {
        return false
      }
      const areaA = (a[2] - a[0]) * (a[3] - a[1])
      const areaB = (b[2] - b[0]) * (b[3] - b[1])
      // Ignore slivers where neighbouring lines barely touch.
      return w * h >= 0.3 * Math.min(areaA, areaB)
    }

    function getPageView(pageNumber) {
      const viewer = PDFViewerApplication.pdfViewer
      if (!viewer || pageNumber < 1 || pageNumber > viewer.pagesCount) {
        return null
      }
      return viewer.getPageView(pageNumber - 1) || null
    }

    // Returns Map<pageNumber, { rects, text }> for the text selected in the
    // pages' text layers. Only text nodes are measured, so empty helper
    // elements (e.g. pdf.js's endOfContent) can't produce page-sized boxes.
    function readSelection() {
      const result = new Map()
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        return result
      }
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i)
        let root = range.commonAncestorContainer
        if (root.nodeType === Node.TEXT_NODE) {
          root = root.parentNode
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!range.intersectsNode(node)) {
            continue
          }
          const parent = node.parentElement
          const pageDiv = parent && parent.closest('.textLayer') && parent.closest('.page')
          if (!pageDiv) {
            continue
          }
          const pageNumber = parseInt(pageDiv.getAttribute('data-page-number'), 10)
          const pageView = getPageView(pageNumber)
          if (!pageView) {
            continue
          }
          const start = node === range.startContainer ? range.startOffset : 0
          const end = node === range.endContainer ? range.endOffset : node.length
          if (start >= end) {
            continue
          }
          const part = document.createRange()
          part.setStart(node, start)
          part.setEnd(node, end)

          // Page content box origin (inside the page border).
          const pageRect = pageDiv.getBoundingClientRect()
          const originX = pageRect.left + pageDiv.clientLeft
          const originY = pageRect.top + pageDiv.clientTop
          const viewport = pageView.viewport

          let entry = result.get(pageNumber)
          if (!entry) {
            entry = { rects: [], text: '' }
            result.set(pageNumber, entry)
          }
          for (const r of part.getClientRects()) {
            if (r.width < 0.5 || r.height < 0.5) {
              continue
            }
            const p1 = viewport.convertToPdfPoint(r.left - originX, r.top - originY)
            const p2 = viewport.convertToPdfPoint(r.right - originX, r.bottom - originY)
            entry.rects.push(normalize([p1[0], p1[1], p2[0], p2[1]]))
          }
          entry.text += node.data.slice(start, end)
        }
      }
      for (const [pageNumber, entry] of result) {
        if (entry.rects.length === 0) {
          result.delete(pageNumber)
        }
      }
      return result
    }

    function renderPage(pageNumber) {
      const pageView = getPageView(pageNumber)
      if (!pageView || !pageView.div) {
        return
      }
      const div = pageView.div
      for (const old of div.querySelectorAll(':scope > .' + LAYER_CLASS + ', :scope > .' + COMMENT_LAYER_CLASS)) {
        old.remove()
      }
      const onPage = highlights.filter((h) => h.page === pageNumber)
      if (onPage.length === 0) {
        return
      }
      const viewport = pageView.viewport
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('class', LAYER_CLASS)
      svg.setAttribute('width', String(Math.floor(viewport.width)))
      svg.setAttribute('height', String(Math.floor(viewport.height)))
      // Map PDF user space onto the page, including scale and rotation.
      const g = document.createElementNS(SVG_NS, 'g')
      g.setAttribute('transform', 'matrix(' + viewport.transform.join(' ') + ')')
      for (const h of onPage) {
        // One path per highlight: overlapping boxes are filled only once.
        const path = document.createElementNS(SVG_NS, 'path')
        const classes = []
        if (h.comment) {
          classes.push('vscode-pdf-commented')
        }
        if (flash && flash.id === h.id && Date.now() < flash.until) {
          classes.push('vscode-pdf-flash')
        }
        if (classes.length) {
          path.setAttribute('class', classes.join(' '))
        }
        path.setAttribute('d', h.rects.map((r) =>
          'M' + r[0] + ' ' + r[1] + 'H' + r[2] + 'V' + r[3] + 'H' + r[0] + 'Z'
        ).join(''))
        g.appendChild(path)
      }
      svg.appendChild(g)
      // Above the canvas, below the text layer so text stays selectable.
      const ref = div.querySelector(':scope > .textLayer, :scope > .annotationLayer, :scope > .annotationEditorLayer')
      if (ref) {
        ref.before(svg)
      } else {
        div.append(svg)
      }

      // Comment markers: on top of everything so they can be hovered/clicked.
      const commented = onPage.filter((h) => h.comment)
      if (commented.length > 0) {
        const layer = document.createElement('div')
        layer.className = COMMENT_LAYER_CLASS
        // Markers sit in the page margin (left or right, whichever is nearer
        // to the highlight) so they never cover text.
        const MARKER_SIZE = 14, EDGE = 3, STEP = MARKER_SIZE + 2
        const pageWidth = Math.floor(viewport.width)
        const placed = []
        for (const h of commented) {
          // Top-left corner of the highlight as displayed (zoom/rotation aware).
          let left = Infinity, top = Infinity
          for (const r of h.rects) {
            const v = viewport.convertToViewportRectangle(r)
            const t = Math.min(v[1], v[3]), l = Math.min(v[0], v[2])
            if (t < top - 1 || (Math.abs(t - top) <= 1 && l < left)) {
              top = t
              left = l
            }
          }
          const marker = document.createElement('div')
          marker.className = 'vscode-pdf-comment-marker'
          const right = left > pageWidth / 2
          let x = right ? pageWidth - EDGE - MARKER_SIZE : EDGE
          // Side by side when several markers share a line.
          while (placed.some((p) => Math.abs(p.x - x) < STEP && Math.abs(p.y - top) < STEP)) {
            x += right ? -STEP : STEP
          }
          placed.push({ x, y: top })
          marker.style.left = x + 'px'
          marker.style.top = top + 'px'
          marker.title = h.comment
          marker.setAttribute('data-highlight-id', h.id)
          marker.addEventListener('mousedown', (e) => e.stopPropagation())
          marker.addEventListener('click', (e) => {
            e.stopPropagation()
            requestEdit(h)
          })
          layer.append(marker)
        }
        div.append(layer)
      }
    }

    function renderAll() {
      if (!ready) {
        return
      }
      const pages = new Set(highlights.map((h) => h.page))
      for (const layer of document.querySelectorAll('.' + LAYER_CLASS + ', .' + COMMENT_LAYER_CLASS)) {
        const pageDiv = layer.closest('.page')
        if (pageDiv) {
          pages.add(parseInt(pageDiv.getAttribute('data-page-number'), 10))
        }
      }
      for (const pageNumber of pages) {
        renderPage(pageNumber)
      }
    }

    function save() {
      vscodeApi.postMessage({ type: 'highlights-changed', highlights })
    }

    function newId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }

    function touches(h, selected) {
      const entry = selected.get(h.page)
      return entry && h.rects.some((a) => entry.rects.some((b) => intersects(a, b)))
    }

    function addFromSelection(selected) {
      const added = []
      for (const [pageNumber, entry] of selected) {
        added.push({
          id: newId(),
          page: pageNumber,
          rects: mergeRects(entry.rects),
          text: entry.text.slice(0, 1000),
          createdAt: Date.now(),
        })
      }
      highlights.push(...added)
      return added
    }

    // Highlight the selection, or remove the highlights it touches.
    // Highlights with a comment are kept so the comment isn't lost by accident.
    function toggle() {
      if (!ready) {
        return
      }
      const selected = readSelection()
      if (selected.size === 0) {
        notify('PDF: Select text in the PDF to highlight.')
        return
      }
      const touched = highlights.filter((h) => touches(h, selected))
      if (touched.length > 0) {
        const removable = touched.filter((h) => !h.comment)
        const kept = touched.length - removable.length
        highlights = highlights.filter((h) => !removable.includes(h))
        if (removable.length === 0) {
          notify('PDF: This highlight has a comment. Clear the comment first to remove it.')
        } else {
          notify('PDF: Removed ' + removable.length + ' highlight(s).' +
            (kept ? ' Kept ' + kept + ' with a comment.' : ''))
        }
      } else {
        addFromSelection(selected)
      }
      window.getSelection().removeAllRanges()
      renderAll()
      save()
    }

    // Ask the extension to show an input box for this highlight's comment.
    function requestEdit(h) {
      vscodeApi.postMessage({
        type: 'edit-comment',
        id: h.id,
        comment: h.comment || '',
        text: h.text || '',
      })
    }

    // Comment on the highlight under the selection (highlighting it first if
    // needed).
    function comment() {
      if (!ready) {
        return
      }
      const selected = readSelection()
      if (selected.size === 0) {
        notify('PDF: Select text (or part of a highlight) to comment on.')
        return
      }
      let target = highlights.find((h) => touches(h, selected))
      if (!target) {
        target = addFromSelection(selected)[0]
        renderAll()
        save()
      }
      window.getSelection().removeAllRanges()
      requestEdit(target)
    }

    // Scroll to a highlight (from the "PDF Comments" view) and flash it.
    function reveal(id) {
      const viewer = PDFViewerApplication.pdfViewer
      if (!ready || !pagesLoaded || !viewer || !viewer.pagesCount) {
        pendingReveal = id // done once the document's pages are loaded
        return
      }
      const h = highlights.find((x) => x.id === id)
      if (!h) {
        return
      }
      const pageView = getPageView(h.page)
      const pageTop = pageView ? pageView.viewport.viewBox[3] : null
      const top = Math.max(...h.rects.map((r) => r[3]))
      // Keep a little context above the highlight.
      viewer.scrollPageIntoView({
        pageNumber: h.page,
        destArray: [null, { name: 'XYZ' }, null, pageTop === null ? top : Math.min(pageTop, top + 60), null],
        allowNegativeOffset: true,
      })
      flash = { id, until: Date.now() + 1600 }
      renderPage(h.page)
      setTimeout(() => {
        flash = null
        renderPage(h.page)
      }, 1700)
    }

    // An empty comment removes it (the highlight stays).
    function setComment(id, text) {
      const h = highlights.find((x) => x.id === id)
      if (!h) {
        return
      }
      const value = typeof text === 'string' ? text.trim() : ''
      if (value) {
        h.comment = value
      } else {
        delete h.comment
      }
      renderAll()
      save()
    }

    function set(list) {
      highlights = Array.isArray(list) ? list : []
      updatedBeforeInit = !ready
      renderAll()
    }

    function init(initial) {
      if (!updatedBeforeInit) {
        highlights = Array.isArray(initial) ? initial : []
      }
      PDFViewerApplication.eventBus.on('pagerendered', (e) => {
        try {
          renderPage(e.pageNumber)
        } catch (err) {
          console.error(err)
        }
      })
      // A reveal requested while the PDF was still opening. Wait a moment so
      // pdf.js has applied its initial view (zoom/position) first.
      PDFViewerApplication.eventBus.on('pagesloaded', () => {
        pagesLoaded = true
        if (pendingReveal) {
          const id = pendingReveal
          pendingReveal = null
          setTimeout(() => {
            try {
              reveal(id)
            } catch (err) {
              console.error(err)
            }
          }, 300)
        }
      })
      ready = true
    }

    return { init, set, toggle, comment, setComment, reveal }
  }())

  // Highlight messages may arrive at any time; errors must not reach
  // window.onerror, which replaces the whole viewer.
  window.addEventListener('message', function (event) {
    const message = event.data || {}
    try {
      if (message.type === 'command' && message.command === 'toggleHighlight') {
        highlighter.toggle()
      } else if (message.type === 'command' && message.command === 'commentHighlight') {
        highlighter.comment()
      } else if (message.type === 'reveal') {
        highlighter.reveal(message.id)
      } else if (message.type === 'set-comment') {
        highlighter.setComment(message.id, message.comment)
      } else if (message.type === 'set-highlights') {
        highlighter.set(message.highlights)
      }
    } catch (err) {
      console.error(err)
    }
  })

  window.addEventListener('load', async function () {
    const config = loadConfig()
    PDFViewerApplicationOptions.set('cMapUrl', config.cMapUrl)
    PDFViewerApplicationOptions.set('standardFontDataUrl', config.standardFontDataUrl)
    const loadOpts = {
      url:config.path,
      useWorkerFetch: false,
      cMapUrl: config.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: config.standardFontDataUrl
    }
    PDFViewerApplication.initializedPromise.then(() => {
      try {
        highlighter.init(config.highlights)
      } catch (err) {
        console.error(err)
      }
      const defaults = config.defaults
      const optsOnLoad = () => {
        PDFViewerApplication.pdfCursorTools.switchTool(cursorTools(defaults.cursor))
        PDFViewerApplication.pdfViewer.currentScaleValue = defaults.scale
        PDFViewerApplication.pdfViewer.scrollMode = scrollMode(defaults.scrollMode)
        PDFViewerApplication.pdfViewer.spreadMode = spreadMode(defaults.spreadMode)
        if (defaults.sidebar) {
          PDFViewerApplication.pdfSidebar.open()
        } else {
          PDFViewerApplication.pdfSidebar.close()
        }
        PDFViewerApplication.eventBus.off('documentloaded', optsOnLoad)
      }
      PDFViewerApplication.eventBus.on('documentloaded', optsOnLoad)
      
      // load() cannot be called before pdf.js is initialized
      // open() makes sure pdf.js is initialized before load()
      PDFViewerApplication.open(config.path).then(async function () {
        const doc = await pdfjsLib.getDocument(loadOpts).promise
        doc._pdfInfo.fingerprints = [config.path]
        PDFViewerApplication.load(doc)
      })
    })

    window.addEventListener('message', async function (event) {
      if (!event.data || event.data.type !== 'reload') {
        return
      }
      // Prevents flickering of page when PDF is reloaded
      const oldResetView = PDFViewerApplication.pdfViewer._resetView
      PDFViewerApplication.pdfViewer._resetView = function () {
        // Drop the old page views (their divs are removed below); otherwise
        // the new pages are appended after them and pagesCount doubles.
        // Scale, location and rotation are kept to preserve the scroll position.
        this._pages = []
        if (this._onBeforeDraw) {
          this.eventBus._off('pagerender', this._onBeforeDraw)
          this._onBeforeDraw = null
        }
        if (this._onAfterDraw) {
          this.eventBus._off('pagerendered', this._onAfterDraw)
          this._onAfterDraw = null
        }
        this._firstPageCapability = (0, pdfjsLib.createPromiseCapability)()
        this._onePageRenderedCapability = (0, pdfjsLib.createPromiseCapability)()
        this._pagesCapability = (0, pdfjsLib.createPromiseCapability)()

        this.viewer.textContent = ""
      }

      // Changing the fingerprint fools pdf.js into keeping scroll position
      const doc = await pdfjsLib.getDocument(loadOpts).promise
      doc._pdfInfo.fingerprints = [config.path]
      PDFViewerApplication.load(doc)

      PDFViewerApplication.pdfViewer._resetView = oldResetView
    });
  }, { once: true });

  window.onerror = function () {
    const msg = document.createElement('body')
    msg.innerText = 'An error occurred while loading the file. Please open it again.'
    document.body = msg
  }
}());
