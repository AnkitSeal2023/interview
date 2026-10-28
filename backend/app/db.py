import logging
from contextlib import contextmanager

import psycopg
from psycopg import Connection
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from app.config import settings

log = logging.getLogger("db")


def _adapt(params):
    """Auto-wrap dict/list params into Jsonb (psycopg doesn't adapt dicts for jsonb)."""
    if not params:
        return params
    return tuple(Jsonb(p) if isinstance(p, (dict, list)) else p for p in params)

_pool: ConnectionPool | None = None


def init_pool() -> None:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.database_url,
            min_size=0,
            max_size=8,
            open=True,
            kwargs={"autocommit": True},
        )
        log.info("db pool ready")


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def get_conn() -> Connection:
    if _pool is None:
        init_pool()
    assert _pool is not None
    with _pool.connection() as conn:
        yield conn


def fetchall(sql: str, params=None) -> list:
    with get_conn() as c:
        cur = c.execute(sql, _adapt(params))
        rows = cur.fetchall()
        if rows and cur.description:
            cols = [d.name for d in cur.description]
            return [dict_api_row(cols, r) for r in rows]
        return []


def fetchone(sql: str, params=None):
    with get_conn() as c:
        cur = c.execute(sql, _adapt(params))
        r = cur.fetchone()
        if r is None:
            return None
        assert cur.description is not None
        cols = [d.name for d in cur.description]
        return dict_api_row(cols, r)


def execute(sql: str, params=None):
    """Execute and return the first row of RETURNING (if any), else None."""
    with get_conn() as c:
        cur = c.execute(sql, _adapt(params))
        if cur.description and cur.rowcount and cur.rowcount > 0:
            r = cur.fetchone()
            assert cur.description is not None
            cols = [d.name for d in cur.description]
            return dict_api_row(cols, r)
        return None


def dict_api_row(cols: list[str], row: tuple) -> dict:
    d = dict(zip(cols, row))
    return d
