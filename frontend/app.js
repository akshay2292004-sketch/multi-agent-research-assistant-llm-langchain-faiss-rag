(() => {
  "use strict";

  const API = (window.API_BASE || "").replace(/\/$/, "");
  const HISTORY_TURNS = 6;
  const TOP_K = 4;
  const MIN_RELEVANCE = 0.3;
  // One tag hue per document: blue, teal, amber, violet, green.
  const HUES = [250, 195, 75, 300, 145];

  const ICONS = {
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  };
  const icon = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  const MODES = {
    rag: ["file", "From your papers"],
    general: ["globe", "General knowledge"],
    summary: ["book", "Summary"],
    info: ["info", "Note"],
  };
  const SUGGESTIONS = {
    papers: [
      "Summarize the paper",
      "What problem does this paper solve?",
      "What methodology is proposed?",
      "What are the key experimental results?",
    ],
    general: [
      "What is retrieval-augmented generation?",
      "Explain the Transformer architecture",
      "How does FAISS vector search work?",
      "Difference between CNN and RNN",
    ],
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    app: document.querySelector(".app"),
    messages: $("messages"),
    empty: $("empty"),
    facts: $("facts"),
    suggestions: $("suggestions"),
    promptLabel: $("prompt-label"),
    composer: $("composer"),
    input: $("input"),
    send: $("send"),
    attach: $("attach-btn"),
    sideAdd: $("side-add"),
    newChat: $("new-chat"),
    fileInput: $("file-input"),
    docList: $("doc-list"),
    crumbMeta: $("crumb-meta"),
    clearPapers: $("clear-papers"),
    statusDot: $("status-dot"),
    statusText: $("status-text"),
    banner: $("banner"),
    themeBtn: $("theme-btn"),
    menuBtn: $("menu-btn"),
    scrim: $("scrim"),
    popover: $("popover"),
    toasts: $("toasts"),
    dropOverlay: $("drop-overlay"),
  };

  const state = { history: [], papers: [], busy: false, online: false, model: "" };
  const sourcesByAnswer = new WeakMap();

  // ------------------------------------------------------------ Storage

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) { /* storage unavailable */ }
    return null;
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  let sessionId = store("ra_session");
  if (!sessionId || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    sessionId = newId();
    store("ra_session", sessionId);
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n).toLocaleString("en-US");

  // ------------------------------------------------------------ Theme

  // Dark is the default; light is an explicit opt-in.
  const effectiveTheme = () => document.documentElement.dataset.theme || "dark";

  function renderThemeButton() {
    const dark = effectiveTheme() === "dark";
    el.themeBtn.innerHTML = icon(dark ? "sun" : "moon");
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    el.themeBtn.setAttribute("aria-label", label);
    el.themeBtn.title = label;
  }
  el.themeBtn.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    if (next === "dark") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    store("ra_theme", next === "dark" ? null : next);
    renderThemeButton();
  });


  // ------------------------------------------------------------ API

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: { "X-Session-Id": sessionId, ...(options.headers || {}) },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return res;
  }

  function setStatus(kind, text, title = "") {
    el.statusDot.className = "status-dot " + kind;
    el.statusText.textContent = text;
    el.statusText.title = title;
  }

  function showBanner(text, kind = "") {
    el.banner.textContent = text;
    el.banner.className = "banner " + kind;
    el.banner.hidden = !text;
  }

  async function connect() {
    setStatus("waiting", "connecting");
    const slowTimer = setTimeout(() => {
      showBanner("Waking up the server. On the free hosting plan this can take up to a minute.");
      setStatus("waiting", "waking server");
    }, 3000);

    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const cfg = await (await api("/api/config")).json();
        clearTimeout(slowTimer);
        state.online = true;
        state.model = cfg.model;
        setStatus("ok", cfg.model.split("/").pop(), cfg.model);
        showBanner(
          cfg.has_api_key ? "" : "No OPENROUTER_API_KEY is configured on the server, so answers will fail until it is set.",
          cfg.has_api_key ? "" : "error"
        );
        await loadPapers();
        updateSendState();
        return;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    clearTimeout(slowTimer);
    setStatus("down", "unreachable");
    showBanner("Can't reach the server. Check that the API is deployed and API_BASE in config.js points to it.", "error");
  }

  // ------------------------------------------------------------ Toasts

  function toast(text, kind = "ok", ms = 4200) {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.innerHTML = `<span class="dot"></span><span></span>`;
    t.lastElementChild.textContent = text;
    el.toasts.appendChild(t);
    const close = () => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 200);
    };
    if (ms) setTimeout(close, ms);
    return close;
  }

  // ------------------------------------------------------------ Papers

  function hueFor(name) {
    const i = state.papers.findIndex((p) => p.name === name);
    return HUES[(i < 0 ? 0 : i) % HUES.length];
  }

  async function loadPapers() {
    try {
      const data = await (await api("/api/papers")).json();
      renderPapers(data.papers);
    } catch (_) { /* shown via status */ }
  }

  function renderPapers(papers) {
    state.papers = papers;
    const n = papers.length;
    const pages = papers.reduce((a, p) => a + p.pages, 0);
    const chunks = papers.reduce((a, p) => a + p.chunks, 0);

    el.crumbMeta.textContent = n ? `${n} document${n > 1 ? "s" : ""} · ${fmt(chunks)} passages` : "";
    el.clearPapers.hidden = n === 0;

    // Sidebar document list
    el.docList.replaceChildren(
      ...papers.map((p, i) => {
        const li = document.createElement("li");
        li.style.animationDelay = `${i * 30}ms`;
        li.title = p.name;
        li.innerHTML = `<span class="tag" style="--hue:${hueFor(p.name)}"></span><span class="name"></span>
          <span class="meta mono">${p.pages}p</span>`;
        li.querySelector(".name").textContent = p.name;
        li.title = `${p.name} · ${p.pages} pages · ${p.chunks} passages`;
        return li;
      })
    );

    // Intro
    el.facts.innerHTML = `
      <div><dt>Documents</dt><dd>${n ? `${n} document${n > 1 ? "s" : ""}` : "Empty"}</dd></div>
      <div><dt>Passages</dt><dd class="mono">${fmt(chunks)}</dd></div>
      <div><dt>Model</dt><dd class="mono" title="${escapeHtml(state.model)}">${escapeHtml(state.model.split("/").pop() || "—")}</dd></div>`;
    el.input.placeholder = n ? "Ask about your papers…" : "Ask a question…";
    el.promptLabel.textContent = n ? "Suggested for your papers" : "Suggested · add a paper to ask about it";
    renderSuggestions();
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!files.length) {
      toast("Only PDF files can be added. Choose a .pdf and try again.", "error");
      return;
    }
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));

    const closeWorking = toast(`Indexing ${files.length} document${files.length > 1 ? "s" : ""}…`, "working", 0);
    try {
      const data = await (await api("/api/papers", { method: "POST", body: form })).json();
      renderPapers(data.papers);
      closeWorking();
      const added = files.length - data.failed.length;
      if (added > 0) toast(`${added} document${added > 1 ? "s" : ""} added to your library.`);
      if (data.failed.length) toast(data.failed.map((f) => `${f.name}: ${f.error}`).join("\n"), "error", 8000);
    } catch (e) {
      closeWorking();
      toast(`Upload failed: ${e.message}. Try again in a moment.`, "error", 8000);
    } finally {
      el.fileInput.value = "";
    }
  }

  // ------------------------------------------------------------ Rendering

  function renderSuggestions() {
    const list = state.papers.length ? SUGGESTIONS.papers : SUGGESTIONS.general;
    el.suggestions.replaceChildren(
      ...list.map((text, i) => {
        const li = document.createElement("li");
        li.innerHTML = `<button type="button" class="suggest-btn"><span class="n">0${i + 1}</span><span class="t"></span>${icon("arrow")}</button>`;
        li.querySelector(".t").textContent = text;
        li.firstElementChild.addEventListener("click", () => ask(text));
        return li;
      })
    );
  }

  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text, { breaks: false, gfm: true }));
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  function linkCitations(container, byNumber) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest("code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) if (/\[\d+\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const frag = document.createDocumentFragment();
      node.nodeValue.split(/(\[\d+\])/).forEach((part) => {
        const m = part.match(/^\[(\d+)\]$/);
        const src = m && byNumber.get(Number(m[1]));
        if (src) {
          const b = document.createElement("button");
          b.className = "cite";
          b.type = "button";
          b.dataset.n = m[1];
          b.textContent = m[1];
          b.setAttribute("aria-label", `Source ${m[1]}: ${src.file}, page ${src.page}`);
          frag.appendChild(b);
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      });
      node.replaceWith(frag);
    });
  }

  function addUserTurn(text) {
    const row = document.createElement("div");
    row.className = "turn turn-user";
    const q = document.createElement("div");
    q.className = "q";
    q.textContent = text;
    row.appendChild(q);
    el.messages.appendChild(row);
  }

  function addAssistantTurn() {
    const row = document.createElement("article");
    row.className = "turn turn-ai";
    const n = state.papers.length;
    row.innerHTML = `
      <header class="ai-head">
        <svg class="ai-mark" aria-hidden="true"><use href="#logo"/></svg>
        <span class="mode-tag" hidden></span>
        <span class="ai-time mono"></span>
      </header>
      <div class="md"><div class="working"><span class="working-bar"></span>${
        n ? `Searching ${n} document${n > 1 ? "s" : ""}…` : "Thinking…"
      }</div></div>`;
    el.messages.appendChild(row);
    return { row, mode: row.querySelector(".mode-tag"), time: row.querySelector(".ai-time"), md: row.querySelector(".md") };
  }

  function setMode(view, mode) {
    const [name, label] = MODES[mode] || MODES.info;
    view.mode.className = "mode-tag " + mode;
    view.mode.innerHTML = `${icon(name)}<span></span>`;
    view.mode.lastElementChild.textContent = label;
    view.mode.hidden = false;
  }

  function renderSources(view, sources, cited) {
    if (!sources.length) return;
    const citedSet = new Set(cited);
    const ordered = [...sources].sort((a, b) => (citedSet.has(b.n) - citedSet.has(a.n)) || a.n - b.n);
    const files = [...new Set(ordered.map((s) => s.file))];
    const details = document.createElement("details");
    details.className = "sources";
    const label = citedSet.size
      ? `<span class="count">${citedSet.size}</span> cited of ${sources.length} retrieved`
      : `<span class="count">${sources.length}</span> retrieved · none cited`;
    details.innerHTML = `<summary><span>Sources</span><span>${label}</span>
      <span class="tags">${files.map((f) => `<span class="tag" style="--hue:${hueFor(f)}"></span>`).join("")}</span>
      ${icon("chevron", "chev")}</summary>
      <table class="src-table"><tbody></tbody></table>`;
    const tbody = details.querySelector("tbody");
    ordered.forEach((s) => {
      const tr = document.createElement("tr");
      if (citedSet.size && !citedSet.has(s.n)) tr.className = "uncited";
      tr.dataset.n = s.n;
      const pct = Math.round(s.score * 100);
      tr.innerHTML = `
        <td class="src-n"><span>${s.n}</span></td>
        <td class="src-doc"><div class="src-file"><span class="tag" style="--hue:${hueFor(s.file)}"></span><span class="name"></span></div>
          <div class="src-snippet"></div></td>
        <td class="src-page mono">p. ${s.page}</td>
        <td class="src-rel"><div class="rel"><span class="rel-bar"><b style="width:${pct}%"></b></span><span class="rel-val mono">${pct}%</span></div></td>`;
      tr.querySelector(".name").textContent = s.file;
      tr.querySelector(".src-snippet").textContent = s.snippet;
      tbody.appendChild(tr);
    });
    view.md.after(details);

    view.md.addEventListener("click", (e) => {
      const btn = e.target.closest(".cite");
      if (!btn) return;
      hidePopover();
      details.open = true;
      const row = tbody.querySelector(`tr[data-n="${btn.dataset.n}"]`);
      if (row) {
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        row.classList.add("flash");
        setTimeout(() => row.classList.remove("flash"), 1500);
      }
    });
    return details;
  }

  // ------------------------------------------------------------ Citation popover

  function showPopover(btn) {
    const md = btn.closest(".md");
    const src = md && sourcesByAnswer.get(md)?.get(Number(btn.dataset.n));
    if (!src) return;
    const p = el.popover;
    const snippet = src.snippet.replace(/\s+/g, " ").trim();
    p.innerHTML = `<div class="pop-head"><span class="tag" style="--hue:${hueFor(src.file)}"></span>
      <span class="name"></span><span class="page mono">p. ${src.page} · ${Math.round(src.score * 100)}%</span></div><p></p>`;
    p.querySelector(".name").textContent = src.file;
    p.querySelector("p").textContent = snippet.length > 260 ? snippet.slice(0, 260).trimEnd() + "…" : snippet;
    p.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
    const top = r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8;
    p.style.left = `${left}px`;
    p.style.top = `${top}px`;
  }
  function hidePopover() { el.popover.hidden = true; }

  el.messages.addEventListener("pointerover", (e) => {
    const btn = e.target.closest(".cite");
    if (btn && e.pointerType !== "touch") showPopover(btn);
  });
  el.messages.addEventListener("pointerout", (e) => { if (e.target.closest(".cite")) hidePopover(); });
  el.messages.addEventListener("focusin", (e) => { if (e.target.matches(".cite")) showPopover(e.target); });
  el.messages.addEventListener("focusout", hidePopover);
  el.messages.addEventListener("scroll", hidePopover, { passive: true });

  // ------------------------------------------------------------ Chat

  const nearBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 140;
  function scrollToBottom(force = false) {
    if (force || nearBottom()) el.messages.scrollTop = el.messages.scrollHeight;
  }

  function appendCaret(container) {
    let target = container.lastElementChild || container;
    while (target.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE)$/.test(target.tagName)) target = target.lastElementChild;
    if (target.tagName === "PRE") return;
    const caret = document.createElement("span");
    caret.className = "caret";
    target.appendChild(caret);
  }

  async function ask(question) {
    question = question.trim();
    if (!question || state.busy) return;
    state.busy = true;
    updateSendState();

    el.empty.hidden = true;
    addUserTurn(question);
    const view = addAssistantTurn();
    scrollToBottom(true);

    const history = state.history.slice(-HISTORY_TURNS);
    let answer = "";
    let mode = "info";
    let byNumber = new Map();
    let sources = [];
    let cited = [];
    let elapsed = null;
    let frame = 0;
    let streaming = true;

    const paint = () => {
      frame = 0;
      if (!answer) return;
      view.md.innerHTML = renderMarkdown(answer);
      if (mode === "rag") linkCitations(view.md, byNumber);
      if (streaming) appendCaret(view.md);
      scrollToBottom();
    };

    try {
      const res = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          history,
          top_k: TOP_K,
          min_relevance: MIN_RELEVANCE,
        }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "meta") {
            mode = ev.mode;
            sources = ev.sources || [];
            byNumber = new Map(sources.map((s) => [s.n, s]));
            sourcesByAnswer.set(view.md, byNumber);
            setMode(view, mode);
          } else if (ev.type === "token") {
            answer += ev.text;
            if (!frame) frame = requestAnimationFrame(paint);
          } else if (ev.type === "done") {
            cited = ev.cited || [];
            elapsed = ev.elapsed;
          }
        }
      }
    } catch (e) {
      setMode(view, mode);
      answer += (answer ? "\n\n" : "") +
        `**The request didn't go through.** ${e.message}. Check your connection and send the question again.`;
    }

    streaming = false;
    if (frame) cancelAnimationFrame(frame);
    paint();
    renderSources(view, sources, cited);
    if (elapsed !== null) view.time.textContent = `${elapsed.toFixed(1)}s`;
    scrollToBottom();

    state.history.push({ role: "user", content: question }, { role: "assistant", content: answer.slice(0, 20000) });
    state.busy = false;
    updateSendState();
    el.input.focus({ preventScroll: true });
  }

  function newChat() {
    if (state.busy) return;
    state.history = [];
    hidePopover();
    el.messages.querySelectorAll(".turn").forEach((m) => m.remove());
    el.empty.hidden = false;
    el.input.focus();
  }

  // ------------------------------------------------------------ Wiring

  function updateSendState() {
    el.send.disabled = state.busy || !state.online || !el.input.value.trim();
    el.send.title = !state.online
      ? "Waiting for the server to connect"
      : state.busy
      ? "Wait for the current answer to finish"
      : !el.input.value.trim()
      ? "Type a question to send"
      : "Send question";
  }

  function autoGrow() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 220) + "px";
  }

  function closeSidebar() { el.app.classList.remove("sidebar-open"); }

  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (el.send.disabled) return;
    const q = el.input.value;
    el.input.value = "";
    autoGrow();
    ask(q);
  });
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });
  el.input.addEventListener("input", () => { autoGrow(); updateSendState(); });

  const pickFiles = () => el.fileInput.click();
  [el.attach, el.sideAdd].forEach((b) => b.addEventListener("click", pickFiles));
  el.fileInput.addEventListener("change", () => el.fileInput.files.length && uploadFiles(el.fileInput.files));

  // Drop PDFs anywhere.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropOverlay.hidden = true;
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  el.clearPapers.addEventListener("click", async () => {
    try {
      const data = await (await api("/api/papers", { method: "DELETE" })).json();
      renderPapers(data.papers);
      toast("All documents removed.");
    } catch (e) {
      toast(`Couldn't remove documents: ${e.message}.`, "error");
    }
  });


  el.newChat.addEventListener("click", newChat);
  el.menuBtn.addEventListener("click", () => el.app.classList.add("sidebar-open"));
  el.scrim.addEventListener("click", closeSidebar);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSidebar(); hidePopover(); return; }
  });

  renderThemeButton();
  renderPapers([]);
  connect();
})();
