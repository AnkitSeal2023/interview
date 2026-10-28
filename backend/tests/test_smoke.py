"""FastAPI TestClient-based smoke tests. Requires the docker Postgres to be up."""
import io

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _pdf_bytes(lines: list[str]) -> bytes:
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=11)
    for ln in lines:
        pdf.cell(text=ln, new_x="LMARGIN", new_y="NEXT")
    return bytes(pdf.output())


VALID = [
    "RAHUL SHARMA", "B.Tech CSE (2023-2027)", "SKILLS: Python, SQL, Git",
    "PROJECTS: B-tree storage engine in C++ with pagination; Flask notes app with JWT",
    "ORGANIZED: club technical hackathon for 200 participants",
] * 4  # ensure >200 chars


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_upload_happy_path(client):
    r = client.post(
        "/api/resume",
        files={"file": ("resume.pdf", io.BytesIO(_pdf_bytes(VALID)), "application/pdf")},
        data={"jd": "Backend SDE intern"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["resume_chars"] > 200 and body["session_id"]


def test_upload_rejects_non_pdf(client):
    r = client.post("/api/resume",
                    files={"file": ("a.txt", io.BytesIO(b"hello"), "text/plain")})
    assert r.status_code == 400
    assert "PDF" in r.json()["detail"]


def test_upload_rejects_scanned_like_pdf(client):
    # a PDF whose text extraction is empty -> 422 with guidance
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()  # blank page = no text
    scan = bytes(pdf.output())
    r = client.post("/api/resume",
                    files={"file": ("scan.pdf", io.BytesIO(scan), "application/pdf")})
    assert r.status_code == 422


def test_session_ownership(client):
    r1 = client.post("/api/resume",
                     files={"file": ("r.pdf", io.BytesIO(_pdf_bytes(VALID)), "application/pdf")})
    sid = r1.json()["session_id"]
    # a different (anonymous) cookie must not read this session
    other = TestClient(app, client="other")
    r2 = other.get(f"/api/sessions/{sid}")
    assert r2.status_code in (403, 404)


# ------------------------------------------------------------------ auth

import uuid as _uuid

EMAIL = f"test-{_uuid.uuid4().hex[:8]}@dev.local"
PW = "hunter2secret"


def _register(client, email=EMAIL, pw=PW):
    return client.post("/api/auth/register",
                       json={"email": email, "password": pw, "name": "Tester"})


def test_register_sets_cookie_and_claims_anonymous(client):
    # anonymous upload first (candidate cookie minted by middleware)
    up = client.post("/api/resume",
                     files={"file": ("r.pdf", io.BytesIO(_pdf_bytes(VALID)), "application/pdf")})
    sid = up.json()["session_id"]
    r = _register(client)
    assert r.status_code == 200
    assert "auth" in r.cookies and r.json()["user"]["email"] == EMAIL
    assert r.json()["claimed_sessions"] == 1
    # claim transferred ownership: history shows it, another client is blocked
    hist = client.get("/api/sessions")
    assert any(x["session_id"] == sid for x in hist.json())
    other = TestClient(app, client="other")
    assert other.get(f"/api/sessions/{sid}").status_code == 403


def test_register_rejects_duplicates_and_weak_password(client):
    assert _register(client).status_code == 409
    assert client.post("/api/auth/register",
                       json={"email": "a@b.dev", "password": "short"}).status_code == 422


def test_login_logout_me_cycle(client):
    r = client.post("/api/auth/login", json={"email": EMAIL, "password": PW})
    assert r.status_code == 200 and r.json()["user"]["name"] == "Tester"
    assert client.post("/api/auth/login",
                       json={"email": EMAIL, "password": "wrong-password"}).status_code == 401
    assert client.get("/api/auth/me").json()["user"]["email"] == EMAIL
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").json()["user"] is None


def test_delete_my_data_scopes_to_account(client):
    # anonymous browser (different cookie) sees nothing this user deleted
    anon = TestClient(app, client="anon3")
    up = anon.post("/api/resume",
                   files={"file": ("r.pdf", io.BytesIO(_pdf_bytes(VALID)), "application/pdf")})
    anon_sid = up.json()["session_id"]
    assert client.post("/api/auth/login", json={"email": EMAIL, "password": PW}).status_code == 200
    r = client.delete("/api/me/data")
    assert r.status_code == 200 and r.json()["scope"] == "account"
    assert client.get("/api/sessions").json() == []
    # the anon browser's own (unclaimed) session is untouched
    assert anon.get(f"/api/sessions/{anon_sid}").status_code in (200, 404)
    # clean up the anon session for idempotent reruns
    anon.delete("/api/me/data")
