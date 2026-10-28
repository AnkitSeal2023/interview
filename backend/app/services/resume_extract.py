"""PDF → plain text. pdfplumber covers text-based PDFs; scanned images are rejected
upstream with a friendly error (SPEC §2 graceful handling)."""
from __future__ import annotations

import io
import logging

import pdfplumber

log = logging.getLogger("resume")


def extract_text(pdf_bytes: bytes) -> str:
    chunks: list[str] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            t = page.extract_text() or ""
            chunks.append(t)
    text = "\n".join(chunks).strip()
    log.info("extracted %d chars from pdf", len(text))
    return text
