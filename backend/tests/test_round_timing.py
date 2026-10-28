from app.services.roundsvc import response_window


def test_follow_up_gets_a_shorter_dynamic_window_than_long_main_question():
    main = response_window(
        {"difficulty": "hard", "payload": {"text": "Explain a complex analytical approach and its trade-offs."}},
        "Data Analyst",
        "senior",
    )
    follow_up = response_window(
        {"difficulty": "hard", "payload": {"text": "Why?", "is_followup": True}},
        "Data Analyst",
        "senior",
    )
    assert main["response_window_seconds"] > follow_up["response_window_seconds"]
    assert 0 < main["nudge_after_seconds"] < main["response_window_seconds"]
