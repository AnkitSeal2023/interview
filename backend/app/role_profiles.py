"""Role-specific interview design shared by prompts, API responses, and the UI."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RoleProfile:
    key: str
    label: str
    focus: str
    stages: tuple[str, str, str]
    competencies: tuple[str, ...]
    practical_mode: str = "oral"


PROFILES: dict[str, RoleProfile] = {
    "Software Engineer": RoleProfile(
        "Software Engineer", "Software Engineer / SDE",
        "software fundamentals, implementation choices, debugging, APIs, data, and system trade-offs",
        ("Technical depth", "Coding & algorithms", "System design"),
        ("Technical correctness", "Problem-solving", "Communication", "Project ownership", "Design reasoning"),
        "code",
    ),
    "Data Analyst": RoleProfile(
        "Data Analyst", "Data Analyst",
        "SQL, data cleaning, statistics, dashboards, experimentation, metrics, and business interpretation",
        ("Analytics depth", "SQL & metrics case", "Business case"),
        ("Analytical reasoning", "SQL and data fluency", "Business judgment", "Communication", "Data quality"),
    ),
    "Data Scientist": RoleProfile(
        "Data Scientist", "Data Scientist",
        "statistics, experimentation, modeling choices, evaluation, feature work, and communicating uncertainty",
        ("Statistical & ML depth", "Modeling case", "Experiment design"),
        ("Statistics", "Machine learning", "Experimentation", "Communication", "Business judgment"),
    ),
    "AI/ML Engineer": RoleProfile(
        "AI/ML Engineer", "AI / ML Engineer",
        "ML systems, data pipelines, model evaluation, deployment, reliability, and production trade-offs",
        ("ML engineering depth", "Model implementation", "ML systems design"),
        ("ML fundamentals", "Engineering execution", "ML systems", "Communication", "Production judgment"),
    ),
    "Data Engineer": RoleProfile(
        "Data Engineer", "Data Engineer",
        "data modeling, ETL/ELT, orchestration, distributed processing, observability, and data quality",
        ("Data platform depth", "Pipeline problem solving", "Data architecture"),
        ("Data modeling", "Pipeline engineering", "Reliability", "Communication", "Trade-off reasoning"),
    ),
    "DevOps / Cloud Engineer": RoleProfile(
        "DevOps / Cloud Engineer", "DevOps / Cloud Engineer",
        "reliability, observability, CI/CD, infrastructure, networking, security, and incident response",
        ("Reliability depth", "Incident & automation case", "Cloud architecture"),
        ("Infrastructure", "Reliability", "Security", "Incident response", "Communication"),
    ),
    "Cybersecurity Analyst": RoleProfile(
        "Cybersecurity Analyst", "Cybersecurity Analyst",
        "threat modeling, detection, incident response, identity, risk, and secure engineering",
        ("Security depth", "Investigation case", "Security architecture"),
        ("Threat analysis", "Investigation", "Risk judgment", "Communication", "Security controls"),
    ),
    "QA / Test Engineer": RoleProfile(
        "QA / Test Engineer", "QA / Test Engineer",
        "test strategy, automation, debugging, quality risks, accessibility, and release confidence",
        ("Quality engineering depth", "Test design case", "Release quality"),
        ("Test strategy", "Debugging", "Automation", "Risk judgment", "Communication"),
    ),
    "Product Manager": RoleProfile(
        "Product Manager", "Product Manager",
        "product sense, user problems, prioritization, metrics, stakeholder alignment, and execution judgment",
        ("Product sense", "Prioritization case", "Product strategy"),
        ("Product judgment", "Prioritization", "Metrics", "Communication", "Execution"),
    ),
    "Business Analyst": RoleProfile(
        "Business Analyst", "Business Analyst",
        "requirements, process analysis, metrics, stakeholder communication, and structured problem solving",
        ("Analysis depth", "Requirements case", "Business process design"),
        ("Requirements", "Analytical reasoning", "Stakeholder management", "Communication", "Process judgment"),
    ),
    "UX / Product Designer": RoleProfile(
        "UX / Product Designer", "UX / Product Designer",
        "user research, interaction decisions, accessibility, prototyping, critique, and design trade-offs",
        ("Design craft", "Design critique case", "Product experience"),
        ("User research", "Interaction design", "Accessibility", "Communication", "Design judgment"),
    ),
}


def profile_for(role: str | None, inferred: str | None = None) -> RoleProfile:
    requested = (role or "").strip()
    if requested in PROFILES:
        return PROFILES[requested]
    inferred = (inferred or "").strip()
    aliases = {
        "data analyst": "Data Analyst",
        "analytics": "Data Analyst",
        "business intelligence": "Data Analyst",
        "bi analyst": "Data Analyst",
        "data scientist": "Data Scientist",
        "machine learning": "AI/ML Engineer",
        "ml engineer": "AI/ML Engineer",
        "data engineer": "Data Engineer",
        "software engineer": "Software Engineer",
        "sde": "Software Engineer",
        "developer": "Software Engineer",
    }
    inferred_low = inferred.lower()
    if inferred_low in aliases:
        return PROFILES[aliases[inferred_low]]
    for key, profile in PROFILES.items():
        if key.lower() == inferred_low or key.lower() in inferred_low:
            return profile
    return PROFILES["Software Engineer"]


def public_profiles() -> list[dict]:
    return [{"key": p.key, "label": p.label, "stages": list(p.stages)}
            for p in PROFILES.values()]
