# 📚 Multi-Agent Research Assistant (LLM · RAG · FAISS)

Chat with your research papers. Upload PDFs, ask questions and get answers grounded in the text with
page-level citations, generate structured summaries, and automatically fall back to general knowledge
when your papers don't cover the question.

Built with a **FastAPI** backend, a custom **HTML/JS** chat frontend, **FAISS**, **fastembed (all-MiniLM-L6-v2)**, **LangChain text splitters** and
**Llama 3.3 70B via OpenRouter**.

## 🔗 Live demo

**▶ [multi-agent-research-assistant-llm.vercel.app](https://multi-agent-research-assistant-llm.vercel.app/)**

| Part | Hosted on | URL |
|---|---|---|
| Web app | Vercel | https://multi-agent-research-assistant-llm.vercel.app/ |
| API (FastAPI) | Render | https://research-assistant-api-yc7f.onrender.com |

> The API runs on Render's free plan and sleeps after ~15 minutes of inactivity. On the first visit the
> app shows *"Waking up the server…"* for up to a minute, then responds normally.

---

## 🚀 Features

- **📄 Cited answers (RAG):** semantic search over your papers; every claim is cited `[1]`, `[2]` with file and page.
- **📑 Summaries:** type *summarize* for objective, methodology, key findings and conclusion of each paper.
- **🌍 General-knowledge fallback:** if no passage is relevant enough, the general agent answers instead and the reply is labelled.
- **🤖 Agent routing:** summary requests, paper questions and general questions go to different agents.
- **💬 Streaming chat with memory:** answers stream token by token and follow-up questions keep context.
- **🔒 Per-session papers:** uploads are indexed in memory per browser session, never shared between visitors.
- **⚙️ Tunable retrieval:** passages per answer and minimum relevance are set by `TOP_K` and `MIN_RELEVANCE` in `frontend/app.js` (defaults 4 and 0.30).

---

## 📂 Project structure

```
├── app.py                # FastAPI backend: sessions, PDF upload, streaming chat API
├── agents.py             # RAG / summary / general agents (OpenRouter, streaming)
├── knowledge_base.py     # PDF loading, chunking, embeddings, FAISS vector store
├── router.py             # Summary vs. question routing
├── requirements.txt
├── render.yaml           # Render Blueprint (deploys the API)
├── .python-version
└── frontend/             # Static chat site (deployed to Vercel)
    ├── index.html
    ├── styles.css
    ├── app.js
    ├── config.js         # API_BASE: where the backend lives
    └── vercel.json
```

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/config` | Model name, whether an API key is set |
| GET / POST / DELETE | `/api/papers` | List, upload (multipart `files`) or clear this session's papers |
| POST | `/api/chat` | `{question, history, top_k, min_relevance}` → streamed NDJSON (`meta`, `token`…, `done`) |

Every request carries an `X-Session-Id` header (the frontend generates one per browser). Papers live in
memory per session and expire after an hour of inactivity.

---

## ⚙️ Run locally

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # Linux / macOS
pip install -r requirements.txt
```

Create a `.env` file (see `.env.example`):

```env
OPENROUTER_API_KEY=your_api_key_here
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct   # optional
```

```bash
uvicorn app:app --reload --port 8000
```

Open http://localhost:8000. The API also serves the `frontend/` folder, so one command runs everything.

---

## ☁️ Deploy

**Render** runs the Python API; **Vercel** hosts the chat site, which calls the API from the browser.

### 1. Push to GitHub

Push this folder to a GitHub repository (`.env`, `.venv` and caches are git-ignored).

### 2. Render (API)

1. In Render choose **New → Blueprint** and select the repository. Render reads `render.yaml`.
2. Enter your `OPENROUTER_API_KEY` when asked.
3. Deploy. The build installs dependencies and pre-downloads the embedding model.
4. Note the URL, e.g. `https://research-assistant-api-yc7f.onrender.com`. Opening it directly also shows the full app.

The free plan sleeps after ~15 minutes idle. The site shows a "waking up" notice while the first
request takes up to a minute.

### 3. Vercel (site)

1. Set `RENDER_API_URL` in `frontend/config.js` to your Render URL and push.
2. In Vercel choose **Add New → Project**, import the repository and set **Root Directory** to `frontend`.
   Framework preset: **Other**, no build command.
3. Deploy.
4. Optional: in Render set `ALLOWED_ORIGINS` to your Vercel URL (e.g. `https://your-site.vercel.app`)
   so only your site can call the API.

---

## 📋 How it works

1. **Upload:** text is extracted per page with pypdf; the bibliography (a standalone *References* heading in the second half of the paper) is dropped.
2. **Index:** pages are split into 800-character chunks (150 overlap), embedded with all-MiniLM-L6-v2 (ONNX via fastembed) and stored in a FAISS index.
3. **Route:** requests starting with *summarize / summary / tl;dr* go to the summary agent; everything else is a question.
4. **Retrieve:** the top-k chunks are scored by cosine similarity. Above the relevance threshold → RAG agent with numbered sources; otherwise → general agent.
5. **Answer:** the reply streams in, cited sources are listed with the matched passages.

---

## 🎯 Future improvements

- Hybrid search (BM25 + FAISS)
- OCR for scanned PDFs
- Table and figure understanding
- Chat history export
- PDF highlighting of cited passages

---

## 📄 License

MIT

## 👨‍💻 Author

**Akshay R** · [GitHub](https://github.com/akshay2292004-sketch) · [LinkedIn](https://linkedin.com/in/akshay-r-7b783a312)
