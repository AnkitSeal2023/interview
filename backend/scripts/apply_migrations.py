"""Apply all .sql files in migrations/ to the database (idempotent CREATE IF NOT EXISTS)."""
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/

from app.config import settings  # noqa: E402


def ensure_database() -> None:
    """Create the target database if it doesn't exist yet (connect via 'postgres' db)."""
    base = settings.database_url.rsplit("/", 1)
    base[1] = "postgres"
    with psycopg.connect("/".join(base), autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = 'interview'").fetchone()
        if not exists:
            conn.execute("CREATE DATABASE interview")
            print("created database 'interview'")


def main() -> None:
    mig_dir = Path(__file__).resolve().parent.parent / "migrations"
    files = sorted(mig_dir.glob("*.sql"))
    if not files:
        print("no migrations found")
        sys.exit(0)
    with psycopg.connect(settings.database_url) as conn, conn.cursor() as cur:
        for f in files:
            cur.execute(f.read_text())
            print(f"applied {f.name}")
        conn.commit()


if __name__ == "__main__":
    ensure_database()
    main()
