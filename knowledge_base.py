"""PDF loading, chunking, embedding and FAISS indexing.

Everything is kept in memory per user session, so several visitors of the
deployed app never see each other's papers.
"""

import io
import os
import re
from collections import Counter
from typing import Dict, List, Tuple

import faiss
import numpy as np
from fastembed import TextEmbedding
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CACHE_DIR = os.getenv(
    "FASTEMBED_CACHE_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".fastembed_cache"),
)

# A line that is only "References" / "Bibliography" (optionally numbered).
REFERENCE_HEADING = re.compile(
    r"^\s*(?:\d+\.?\s*)?(references|bibliography)\s*$", re.IGNORECASE | re.MULTILINE
)
CITATION_MARKERS = re.compile(r"\[\d+(?:\s*[,–-]\s*\d+)*\]")


def get_embeddings() -> TextEmbedding:
    return TextEmbedding(model_name=EMBEDDING_MODEL, cache_dir=CACHE_DIR)


def _embed(model: TextEmbedding, texts: List[str]) -> np.ndarray:
    vectors = np.array(list(model.embed(texts, batch_size=32)), dtype="float32")
    faiss.normalize_L2(vectors)
    return vectors


class VectorStore:
    """Minimal in-memory FAISS store (exact search over unit vectors)."""

    def __init__(self, chunks: List[Document], model: TextEmbedding):
        self.chunks = chunks
        self.model = model
        vectors = _embed(model, [c.page_content for c in chunks])
        self.index = faiss.IndexFlatL2(vectors.shape[1])
        self.index.add(vectors)

    def similarity_search_with_score(self, query: str, k: int = 4) -> List[Tuple[Document, float]]:
        """Return (chunk, squared L2 distance) pairs, closest first."""
        k = min(k, len(self.chunks))
        distances, ids = self.index.search(_embed(self.model, [query]), k)
        return [(self.chunks[i], float(d)) for d, i in zip(distances[0], ids[0]) if i != -1]


def clean_citations(text: str) -> str:
    """Remove the paper's own [12] style citation markers so they don't
    get confused with the assistant's source numbers."""
    return CITATION_MARKERS.sub("", text)


def load_pdf(name: str, data: bytes) -> List[Document]:
    """Extract one Document per page, dropping the bibliography.

    The reference section is detected as a standalone "References" heading in
    the second half of the paper; that page is cut at the heading and every
    later page is skipped.
    """
    reader = PdfReader(io.BytesIO(data))
    total = len(reader.pages)
    docs: List[Document] = []

    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""

        match = REFERENCE_HEADING.search(text) if i >= total * 0.4 else None
        if match:
            text = text[: match.start()]

        if text.strip():
            docs.append(
                Document(page_content=text, metadata={"source": name, "page": i})
            )

        if match:
            break

    return docs


def build_index(docs: List[Document], embeddings: TextEmbedding) -> Tuple[VectorStore, Dict[str, int]]:
    splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=150)
    chunks = splitter.split_documents(docs)
    vector_db = VectorStore(chunks, embeddings)
    per_source = Counter(c.metadata["source"] for c in chunks)
    return vector_db, dict(per_source)


def distance_to_relevance(distance: float) -> float:
    """FAISS returns squared L2 distance; for unit vectors that maps to
    cosine similarity as 1 - d/2."""
    return max(0.0, min(1.0, 1 - distance / 2))
