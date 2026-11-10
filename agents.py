"""LLM agents, served through OpenRouter's OpenAI-compatible API.

Every agent returns a generator of text chunks so the UI can stream the
answer token by token (and keep the model's markdown formatting intact).
"""

import os
from typing import Iterator, Optional

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

MODEL = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct")

_client: Optional[OpenAI] = None


def get_api_key() -> str:
    return os.getenv("OPENROUTER_API_KEY", "").strip()


def has_api_key() -> bool:
    return bool(get_api_key())


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(
            api_key=get_api_key(),
            base_url="https://openrouter.ai/api/v1",
            default_headers={"X-Title": "Multi-Agent Research Assistant"},
        )
    return _client


def _stream(messages, temperature: float, max_tokens: int) -> Iterator[str]:
    if not has_api_key():
        yield (
            "**No API key configured.** Set the `OPENROUTER_API_KEY` "
            "environment variable (locally in `.env`, or in your Render "
            "service settings) and restart the app."
        )
        return

    try:
        stream = _get_client().chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
    except Exception as e:  # surface API problems in the chat instead of crashing
        yield f"\n\n**The model request failed:** {e}"


RAG_SYSTEM_PROMPT = """You are an expert research assistant.

Answer ONLY using the numbered sources provided by the user.

Rules:
- Use only the provided text; do not use outside knowledge.
- Cite sources inline using [1], [2], [3] matching the [Source N] labels.
- Every factual statement needs a citation. Never invent citations.
- If information comes from several sources, cite all of them.
- Use clear markdown: short paragraphs, bullet lists where helpful.
- If the answer is not in the sources, reply exactly:
  "I couldn't find this information in the provided documents."
"""


def answer_question(question: str, context: str, history=None) -> Iterator[str]:
    messages = [{"role": "system", "content": RAG_SYSTEM_PROMPT}]
    messages += history or []
    messages.append(
        {
            "role": "user",
            "content": f"SOURCES:\n{context}\n\nQUESTION:\n{question}",
        }
    )
    return _stream(messages, temperature=0, max_tokens=800)


def summarize_document(text: str) -> Iterator[str]:
    messages = [
        {
            "role": "system",
            "content": "You are an expert research assistant who writes "
            "precise, well-structured summaries of research papers.",
        },
        {
            "role": "user",
            "content": f"""Summarize the research paper(s) below using only the provided text.
If there are several papers, summarize each one under its own heading.

For each paper provide these markdown sections:
### Main objective
### Methodology
### Key findings
### Conclusion

TEXT:
{text}
""",
        },
    ]
    return _stream(messages, temperature=0, max_tokens=1200)


def general_answer(question: str, history=None) -> Iterator[str]:
    messages = [
        {
            "role": "system",
            "content": "You are a helpful, knowledgeable AI assistant. "
            "Answer clearly and concisely using markdown.",
        }
    ]
    messages += history or []
    messages.append({"role": "user", "content": question})
    return _stream(messages, temperature=0.3, max_tokens=800)
