"""Salary estimation (SPEC §6): score is a modulator, never the sole input.

Configurable cap SALARY_CAP_INR (default ₹200000/yr per the project brief's initial
constraint). Evidence-first with explicit assumptions and an honesty flag when data is thin.
Per SPEC: "if evidence is thin, it says 'insufficient evidence' instead of inventing a
precise number" — an interview that assessed nothing yields NO figure, because a
resume-only rupee claim presented as a validated outcome would be fabrication.
"""
from __future__ import annotations

import logging
import re

from app.config import settings

log = logging.getLogger("salary")

# evidence weights (0..1 contribution each), tuned to be transparent, not science
WEIGHTS = {
    "skills": 0.35,
    "projects": 0.25,
    "experience": 0.15,
    "education": 0.10,
    "role_market": 0.15,
}

HIGH_DEMAND_SKILLS = {"docker", "kubernetes", "aws", "golang", "go", "rust", "react",
                      "typescript", "kafka", "sql", "postgresql", "flask", "fastapi",
                      "django", "spring boot"}
TIER1_COLLEGES = ["iit", "nit", "iiit", "bits"]
ROLE_PREFIXES = {"backend": 1.1, "ml": 1.25, "data": 1.05, "devops": 1.05,
                 "full stack": 1.0, "fullstack": 1.0, "frontend": 0.95,
                 "sde": 1.0, "software": 1.0}


def estimate(session: dict, interview_score: float | None) -> dict:
    """Estimate from resume evidence, modulated by the assessed interview score.

    `interview_score=None` means the interview produced no assessable evidence
    (overall was None) — the estimate is then withheld with insufficient-evidence
    reasons instead of printing a resume-only number.
    """
    s = session.get("resume_structured") or {}
    cap = int(settings.salary_cap_inr)
    ev: dict[str, float] = {}

    skills = [x.lower() for x in (s.get("skills") or [])]
    ev["skills"] = min(1.0, (len(skills) / 8) * (1 + 0.15 * sum(
        1 for k in skills if k in HIGH_DEMAND_SKILLS)))

    projects = s.get("projects") or []
    proj_depth = 0.0
    for p in projects:
        hl = len(p.get("highlights") or [])
        tech = len(p.get("tech") or [])
        proj_depth = max(proj_depth, min(1.0, 0.4 * int(tech > 0) + 0.4 * int(hl > 0)
                                        + 0.2 * int(len((p.get("description") or "")) > 60)))
    ev["projects"] = proj_depth

    yrs = float(s.get("years_experience") or 0)
    ev["experience"] = min(1.0, yrs / 3)

    edu = " ".join(e.get("degree", "") + e.get("institution", "")
                   for e in (s.get("education") or [])).lower()
    ev["education"] = 0.7 if any(t in edu for t in TIER1_COLLEGES) else 0.4

    # normalize role punctuation ("Full-Stack Engineer" → "full stack engineer") so the
    # prefix table matches; unknown/absent roles fall back to a generic multiplier
    role = re.sub(r"[-_/]+", " ",
                  (s.get("inferred_target_role") or session.get("role") or "")).strip().lower()
    ev["role_market"] = 0.6 * (max((v for k, v in ROLE_PREFIXES.items() if k in role),
                                   default=0.9)
                               if role else 0.9)

    base_ev = sum(ev[k] * WEIGHTS[k] for k in WEIGHTS)  # 0..1
    thin = base_ev < 0.3
    unassessed = interview_score is None

    evidence_block = {k: round(v, 2) for k, v in ev.items()}
    shared_assumptions = [
        f"Range constrained by SALARY_CAP_INR = ₹{cap} (project-config)",
        f"Skills evidence weight {WEIGHTS['skills']}: {', '.join(skills[:8]) or 'none'}",
        f"Project depth evidence: {len(projects)} project(s), deepest scores "
        f"{ev['projects']:.0%}",
        f"Experience: {yrs:.1f} yrs; education tier: {'tier1' if ev['education'] >= 0.7 else 'other'}",
    ]
    shared_limits = ("If the cap is below the target role's real market range (very likely "
                     "as shipped), raise SALARY_CAP_INR; the estimator is transparent but "
                     "rough, and market data was not consulted.")

    if thin or unassessed:
        # SPEC §6: insufficient evidence → no invented number.
        reason = (
            "The interview produced no assessable answers, so there is no performance "
            "evidence to ground an estimate — a resume-only figure would be speculation."
            if unassessed else
            f"Resume evidence is too thin (composite {base_ev:.2f} < 0.30) to ground even "
            "a rough range."
        )
        log.info("salary estimate withheld: %s", reason)
        return {
            "available": False,
            "insufficient_evidence": True,
            "reason": reason,
            "confidence": "low",
            "cap_inr": cap,
            "assumptions": [*shared_assumptions,
                            ("No estimate produced: the interview score acts only as a "
                             "modulator, and there was nothing to modulate."
                             if unassessed else
                             f"No estimate produced: composite evidence {base_ev:.2f} is "
                             "below the 0.30 threshold.")],
            "limitations": shared_limits,
            "evidence": evidence_block,
        }

    # interview performance modulates, max +-15% (never the sole driver)
    mod = 0.92 + 0.015 * max(0.0, min(10.0, float(interview_score)))
    point = round(cap * base_ev * mod)

    lo = int(point * 0.8) // 5000 * 5000
    hi = min(cap, int(point * 1.20) // 5000 * 5000 + 5000)
    return {
        "available": True,
        "point_estimate_inr": point,
        "range_inr": [lo, hi],
        "cap_inr": cap,
        "confidence": "medium-high",
        "assumptions": [*shared_assumptions,
                        f"Interview score used only as a modulator ({mod:.2f}x)",
                        "NOT calibrated against live market data — no salary API "
                        "consulted; treat as a relative signal only"],
        "limitations": shared_limits,
        "evidence": evidence_block,
    }
