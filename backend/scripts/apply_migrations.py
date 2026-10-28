"""Apply all .sql files in migrations/ to the database (idempotent CREATE IF NOT EXISTS).

init.sql always runs first: the numbered files reference its tables
(002_users.sql alters `sessions`), and plain filename sorting would regroup
them alphabetically after it — only ever observable on a fresh install.
"""
import sys
import time
from pathlib import Path

import psycopg
from psycopg import OperationalError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/

from app.config import settings  # noqa: E402

DB_CONNECT_ATTEMPTS = 30
DB_CONNECT_DELAY_SECONDS = 2


def connect_with_retry(database_url: str):
    """Wait for Compose DNS and PostgreSQL to become available."""
    last_error = None
    for attempt in range(1, DB_CONNECT_ATTEMPTS + 1):
        try:
            return psycopg.connect(database_url)
        except OperationalError as error:
            last_error = error
            if attempt == DB_CONNECT_ATTEMPTS:
                raise
            print(
                f"database unavailable (attempt {attempt}/{DB_CONNECT_ATTEMPTS}); "
                f"retrying in {DB_CONNECT_DELAY_SECONDS}s: {error}",
                flush=True,
            )
            time.sleep(DB_CONNECT_DELAY_SECONDS)
    raise last_error  # pragma: no cover


def ensure_database() -> None:
    """Create the target database if it doesn't exist yet (connect via 'postgres' db)."""
    base = settings.database_url.rsplit("/", 1)
    base[1] = "postgres"
    with connect_with_retry("/".join(base)) as conn:
        conn.autocommit = True
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = 'interview'").fetchone()
        if not exists:
            conn.execute("CREATE DATABASE interview")
            print("created database 'interview'")


def main() -> None:
    mig_dir = Path(__file__).resolve().parent.parent / "migrations"
    files = sorted(mig_dir.glob("*.sql"),
                   key=lambda p: (0 if p.name == "init.sql" else 1, p.name))
    if not files:
        print("no migrations found")
        sys.exit(0)
    with connect_with_retry(settings.database_url) as conn, conn.cursor() as cur:
        for f in files:
            cur.execute(f.read_text())
            print(f"applied {f.name}")
        conn.commit()


if __name__ == "__main__":
    ensure_database()
    main()
