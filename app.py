"""FastAPI backend for the Multi-Agent Research Assistant.

Endpoints (all under /api):
  GET    /health          liveness probe for Render
  GET    /config          model name and whether an API key is configured
  GET    /papers          papers indexed for this session
  POST   /papers          upload PDFs (multipart, field "files") and re-index
  DELETE /papers          drop this session's papers
  POST   /chat            ask a question; streams NDJSON events

Each browser sends an `X-Session-Id` header. Papers and their FAISS index are
kept in memory per session and expire after an hour of inactivity.

If a `frontend/` folder sits next to this file it is served at `/`, so one
Render service can host both the API and the site.
"""

import json
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from typing import Dict, List, Literal, Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agents import MODEL, answer_question, general_answer, has_api_key, summarize_document
from knowledge_base import build_index, clean_citations, distance_to_relevance, get_embeddings, load_pdf
from router import route_question

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_PAPERS = 10
SESSION_TTL_SECONDS = 60 * 60
MAX_SESSIONS = 40
SUMMARY_CHAR_BUDGET = 60_000
HISTORY_TURNS = 6
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")

# ---------------------------------------------------------------- Embeddings

_model = None
_model_lock = threading.Lock()


def embeddings():
    global _model
    with _model_lock:
        if _model is None:
            _model = get_embeddings()
    return _model


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm the embedding model in the background so the first upload is fast.
    threading.Thread(target=embeddings, daemon=True).start()
    yield


# ---------------------------------------------------------------- Sessions


class Session:
    def __init__(self):
        self.page_docs: Dict[str, list] = {}   # paper name -> page Documents
        self.chunk_counts: Dict[str, int] = {}
        self.vector_db = None
        self.last_used = time.time()
        self.lock = threading.Lock()

    def papers(self) -> List[dict]:
        return [
            {"name": name, "pages": len(docs), "chunks": self.chunk_counts.get(name, 0)}
            for name, docs in self.page_docs.items()
        ]

    def reindex(self):
        docs = [d for pages in self.page_docs.values() for d in pages]
        if docs:
            self.vector_db, self.chunk_counts = build_index(docs, embeddings())
        else:
            self.vector_db, self.chunk_counts = None, {}


_sessions: Dict[str, Session] = {}
_sessions_lock = threading.Lock()


def get_session(session_id: Optional[str]) -> Session:
    if not session_id or not SESSION_ID.match(session_id):
        raise HTTPException(400, "Missing or invalid X-Session-Id header.")
    now = time.time()
    with _sessions_lock:
        for sid in [s for s, v in _sessions.items() if now - v.last_used > SESSION_TTL_SECONDS]:
            del _sessions[sid]
        session = _sessions.get(session_id)
        if session is None:
            if len(_sessions) >= MAX_SESSIONS:
                oldest = min(_sessions, key=lambda s: _sessions[s].last_used)
                del _sessions[oldest]
            session = _sessions[session_id] = Session()
        session.last_used = now
        return session


# ---------------------------------------------------------------- App

app = FastAPI(title="Multi-Agent Research Assistant API", lifespan=lifespan)

allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Session-Id"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def config():
    return {"model": MODEL, "has_api_key": has_api_key(), "max_file_mb": MAX_FILE_BYTES // (1024 * 1024)}


@app.get("/api/papers")
def list_papers(x_session_id: Optional[str] = Header(None)):
    return {"papers": get_session(x_session_id).papers()}


@app.delete("/api/papers")
def clear_papers(x_session_id: Optional[str] = Header(None)):
    session = get_session(x_session_id)
    with session.lock:
        session.page_docs, session.chunk_counts, session.vector_db = {}, {}, None
    return {"papers": []}


@app.post("/api/papers")
def upload_papers(files: List[UploadFile] = File(...), x_session_id: Optional[str] = Header(None)):
    session = get_session(x_session_id)
    failed = []
    with session.lock:
        for f in files:
            name = os.path.basename(f.filename or "paper.pdf")
            if not name.lower().endswith(".pdf"):
                failed.append({"name": name, "error": "Not a PDF file."})
                continue
            if name not in session.page_docs and len(session.page_docs) >= MAX_PAPERS:
                failed.append({"name": name, "error": f"Limit of {MAX_PAPERS} papers per session reached."})
                continue
            data = f.file.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                failed.append({"name": name, "error": "File is larger than 50 MB."})
                continue
            try:
                docs = load_pdf(name, data)
            except Exception as e:
                failed.append({"name": name, "error": f"Could not read PDF ({e})."})
                continue
            if not docs:
                failed.append({"name": name, "error": "No extractable text (scanned PDF?)."})
                continue
            session.page_docs[name] = docs
        session.reindex()
        return {"papers": session.papers(), "failed": failed}


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20_000)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4_000)
    history: List[ChatTurn] = []
    top_k: int = Field(4, ge=1, le=10)
    min_relevance: float = Field(0.30, ge=0.0, le=1.0)


def _event(**payload) -> str:
    return json.dumps(payload) + "\n"


def _summary_text(session: Session) -> str:
    budget = SUMMARY_CHAR_BUDGET // max(1, len(session.page_docs))
    parts = []
    for name, docs in session.page_docs.items():
        body = "\n\n".join(d.page_content for d in docs)[:budget]
        parts.append(f"=== PAPER: {name} ===\n{body}")
    return "\n\n".join(parts)


@app.post("/api/chat")
def chat(req: ChatRequest, x_session_id: Optional[str] = Header(None)):
    """Stream newline-delimited JSON events:

    {"type": "meta", "mode": "rag"|"general"|"summary"|"info", "sources": [...]}
    {"type": "token", "text": "..."}            (repeated)
    {"type": "done", "cited": [1, 2], "elapsed": 1.9}
    """
    session = get_session(x_session_id)
    history = [t.model_dump() for t in req.history[-HISTORY_TURNS:]]
    question = req.question.strip()
    route = route_question(question)

    def events():
        start = time.time()
        cited: List[int] = []

        if route == "SUMMARY" and not session.page_docs:
            yield _event(type="meta", mode="info", sources=[])
            yield _event(type="token", text="Upload at least one PDF and I'll summarize it for you.")

        elif route == "SUMMARY":
            yield _event(type="meta", mode="summary", sources=[])
            for text in summarize_document(_summary_text(session)):
                yield _event(type="token", text=text)

        else:
            relevant = []
            if session.vector_db is not None:
                results = session.vector_db.similarity_search_with_score(question, k=req.top_k)
                relevant = [
                    (doc, distance_to_relevance(d))
                    for doc, d in results
                    if distance_to_relevance(d) >= req.min_relevance
                ]

            if relevant:
                numbers: Dict[tuple, int] = {}
                sources: Dict[int, dict] = {}
                context = []
                for doc, score in relevant:
                    file = doc.metadata.get("source", "Unknown")
                    page = doc.metadata.get("page", 0) + 1
                    n = numbers.setdefault((file, page), len(numbers) + 1)
                    text = clean_citations(doc.page_content).strip()
                    context.append(f"[Source {n}] ({file}, page {page})\n{text}")
                    if n not in sources or score > sources[n]["score"]:
                        sources[n] = {"n": n, "file": file, "page": page, "score": round(score, 3), "snippet": text}

                yield _event(type="meta", mode="rag", sources=sorted(sources.values(), key=lambda s: s["n"]))
                answer = []
                for text in answer_question(question, "\n\n".join(context), history):
                    answer.append(text)
                    yield _event(type="token", text=text)
                used = {int(x) for x in re.findall(r"\[(\d+)\]", "".join(answer))}
                cited = sorted(used & set(sources))
            else:
                yield _event(type="meta", mode="general", sources=[])
                for text in general_answer(question, history):
                    yield _event(type="token", text=text)

        yield _event(type="done", cited=cited, elapsed=round(time.time() - start, 2))

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
