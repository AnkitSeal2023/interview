from app.role_profiles import profile_for, public_profiles
from app.services.resume_struct import _canonical_role


def test_profiles_cover_supported_roles_with_three_stages():
    profiles = public_profiles()
    assert len(profiles) >= 10
    assert all(len(p["stages"]) == 3 for p in profiles)
    assert any(p["key"] == "Data Analyst" for p in profiles)


def test_non_engineering_roles_are_not_forced_into_code_or_system_design():
    analyst = profile_for("Data Analyst")
    assert analyst.practical_mode == "oral"
    assert analyst.stages == ("Analytics depth", "SQL & metrics case", "Business case")


def test_unknown_role_preserves_safe_software_engineer_compatibility():
    assert profile_for("legacy role").key == "Software Engineer"


def test_resume_evidence_wins_over_generic_inference():
    resume = "DATA ANALYST | SQL | Tableau | dashboard development and data visualization"
    assert _canonical_role(resume, "Software Engineer") == "Data Analyst"
