import re

SUMMARY_PATTERN = re.compile(
    r"^\s*(summari[sz]e|summary|tl;?dr|give me (a|an) (summary|overview)"
    r"|(what is|what's) (this|the) paper about)\b",
    re.IGNORECASE,
)


def route_question(question: str) -> str:
    """Return "SUMMARY" for summarization requests, otherwise "QUESTION".

    QUESTION is later resolved to RAG or general knowledge based on how
    relevant the uploaded papers are to the query.
    """
    if SUMMARY_PATTERN.match(question):
        return "SUMMARY"
    return "QUESTION"
