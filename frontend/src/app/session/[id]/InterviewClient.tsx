"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import type { RoundState, SessionView } from "@/lib/types";
import { speak, type VoiceState, useStt } from "@/lib/voice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Home } from "lucide-react";

type Tell = {
	who: "q" | "a" | "sys";
	text: string;
	meta?: string;
	qOrd?: number;
};

// candidate messages shown optimistically while the answer request is in flight
type SendStatus = "sending" | "sent" | "failed";
type PendingMsg = {
	id: number;
	text: string;
	status: SendStatus;
	source: "text" | "stt";
};

// live round countdown; null when the round data can't be timed (or it's over)
function useCountdown(
	budgetMin: number | undefined,
	startedAt: string | undefined,
	running: boolean,
) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [running]);
	if (!budgetMin || !startedAt) return null;
	// server ts: "2026-10-27 10:44:06.2+00" — needs T-separator and "+00"→"+00:00" for Date()
	const start = new Date(
		startedAt.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"),
	).getTime();
	if (Number.isNaN(start)) return null;
	const left = Math.round((start + budgetMin * 60_000 - now) / 1000);
	return running ? Math.max(0, left) : null;
}

export function InterviewClient({ sid }: { sid: string }) {
	const router = useRouter();

	const [session, setSession] = useState<SessionView | null>(null);
	const [rounds, setRounds] = useState<
		{
			round_id: string;
			round_type: string;
			status: string;
			current?: boolean;
		}[]
	>([]);
	const [round, setRound] = useState<RoundState | null>(null);
	const [initializing, setInitializing] = useState(true);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [nextRoundReady, setNextRoundReady] = useState(false);
	const [endOpen, setEndOpen] = useState(false);
	const [pendingMsgs, setPendingMsgs] = useState<PendingMsg[]>([]);
	const nextMsgIdRef = useRef(1);
	const [tts, setTts] = useState(true);
	const [inputMode, setInputMode] = useState<"voice" | "text">("voice");
	const [finalReport, setFinalReport] = useState<Record<
		string,
		unknown
	> | null>(null);
	// speech-synced reveal of the latest interviewer question ("" = about to speak)
	const [reveal, setReveal] = useState<{ ord: number; shown: string } | null>(
		null,
	);
	const [voiceState, setVoiceState] = useState<VoiceState>("idle");
	const [voiceReady, setVoiceReady] = useState(false);
	const voiceCancelRef = useRef<(() => void) | null>(null);
	const autoSkipRef = useRef(false);
	const responseStartRef = useRef<{ questionId: string; at: number } | null>(
		null,
	);
	const openPromiseRef = useRef<Promise<void> | null>(null);
	const spokenQuestionRef = useRef<string | null>(null);
	const spokenNudgeRef = useRef<string | null>(null);
	const draftRef = useRef("");
	const busyRef = useRef(false);
	const pendingSendRef = useRef(false);
	const idleRef = useRef<
		(phase: "nudge" | "advance", questionId: string) => Promise<void>
	>(async () => {});
	const toastTimerRef = useRef<number | null>(null);
	const chatRef = useRef<HTMLDivElement>(null);
	const stt = useStt((t) => setDraft((d) => (d ? `${d} ${t}` : t)));
	const sttStateRef = useRef(stt.state);
	useEffect(() => {
		draftRef.current = draft;
		busyRef.current = busy;
		sttStateRef.current = stt.state;
	}, [draft, busy, stt.state]);

	// leaving the interview page must stop the interviewer's voice immediately —
	// a mid-speech audio otherwise leaks into the next session's opening line
	// (two overlapping voices with different text)
	useEffect(() => {
		return () => {
			voiceCancelRef.current?.();
		};
	}, []);

	// keep the just-sent (optimistic) message in view
	useEffect(() => {
		if (pendingMsgs.length === 0) return;
		chatRef.current?.scrollTo({
			top: chatRef.current.scrollHeight,
			behavior: "smooth",
		});
	}, [pendingMsgs.length]);

	function showToast(message: string) {
		setToast(message);
		if (toastTimerRef.current !== null) {
			window.clearTimeout(toastTimerRef.current);
		}
		toastTimerRef.current = window.setTimeout(() => setToast(null), 2800);
	}

	// load session + first round
	useEffect(() => {
		if (openPromiseRef.current) return;
		openPromiseRef.current = (async () => {
			try {
				const s = await api.get<SessionView>(`/sessions/${sid}`);
				setSession(s);
				const rs = await api.get<
					{
						round_id: string;
						round_type: string;
						status: string;
						current?: boolean;
					}[]
				>(`/sessions/${sid}/rounds`);
				setRounds(rs);
				if (s.status === "aborted" || s.status === "completed") {
					// Terminal sessions are history views: never reopen or regenerate a round.
					// Prefer the latest saved round so completed and exited interviews show their transcript.
					const states = await Promise.all(
						rs.map((item) => api.get<RoundState>(`/rounds/${item.round_id}`)),
					);
					const historical = states.filter(
						(state) => state.questions.length > 0,
					);
					setRound(historical.at(-1) ?? states.at(-1) ?? null);
					return;
				}
				const current =
					rs.find((item) => item.current) ??
					rs.find((item) => item.status === "active") ??
					rs.find((item) => item.status === "pending") ??
					rs[0];
				if (!current) return;
				if (s.status === "paused") {
					setRound(await api.get<RoundState>(`/rounds/${current.round_id}`));
					return;
				}
				// A finished stage is waiting for the user's proceed/later decision —
				// don't silently auto-start the next stage on reload; surface the
				// completed transcript with a "Continue to next stage" action instead.
				if (
					current.status === "pending" &&
					rs.some((item) => item.status === "completed")
				) {
					const lastCompleted = [...rs]
						.reverse()
						.find((item) => item.status === "completed");
					if (lastCompleted) {
						setRound(await api.get<RoundState>(`/rounds/${lastCompleted.round_id}`));
						return;
					}
				}
				// The opener is idempotent and also repairs an active round that has no question.
				await api.post(`/rounds/${current.round_id}/open`);
				setRound(await api.get<RoundState>(`/rounds/${current.round_id}`));
				if (s.status !== "paused") showToast("Interview started");
			} catch (e) {
				setErr(String(e));
			} finally {
				setInitializing(false);
			}
		})();
	}, [sid]);

	const tells: Tell[] = useMemo(() => {
		if (!round) return [];
		const out: Tell[] = [];
		for (const q of round.questions) {
			if (q.kind === "dsa") {
				out.push({
					who: "q",
					text: `${q.payload.intro ?? ""}DSA problem — **${q.payload.title}**:\n\n${q.payload.statement}`,
					meta: `signature: ${q.payload.signature}`,
					qOrd: q.ord,
				});
			} else {
				out.push({
					who: "q",
					text: q.payload.text ?? "",
					meta: `${q.topic ?? ""}${q.payload.is_followup ? " · follow-up" : ""}`,
					qOrd: q.ord,
				});
			}
			for (const a of q.answers) {
				out.push({ who: "a", text: a.text });
			}
		}
		return out;
	}, [round]);

	const lastQuestionId = round?.questions.at(-1)?.question_id;
	useEffect(() => {
		chatRef.current?.scrollTo({
			top: chatRef.current.scrollHeight,
			behavior: "smooth",
		});
		const lastQ = round?.questions.at(-1);
		if (!lastQ || !tts || !round?.current) return;
		const speechKey = `${round.round_id}:${lastQ.question_id}:${tts ? "on" : "off"}`;
		if (spokenQuestionRef.current === speechKey) return;
		spokenQuestionRef.current = speechKey;
		voiceCancelRef.current?.();
		window.setTimeout(() => {
			setVoiceReady(false);
		}, 0);
		autoSkipRef.current = false;
		// speak each question exactly ONCE — even across page reloads (localStorage marker)
		const key = `spoken:${sid}:${round?.round_id}:${lastQ.ord}`;
		try {
			if (localStorage.getItem(key)) {
				window.setTimeout(() => {
					setVoiceReady(true);
					setReveal(null);
					responseStartRef.current = {
						questionId: lastQ.question_id,
						at: Date.now(),
					};
				}, 0);
				return;
			}
			localStorage.setItem(key, "1");
		} catch {
			/* storage unavailable — speak anyway (may repeat on reload) */
		}
		const oral = !!lastQ.payload.text; // DSA questions are spoken by title only → no sync
		if (oral) {
			const ord = lastQ.ord;
			window.setTimeout(() => setReveal({ ord, shown: "" }), 0);
		}
		voiceCancelRef.current = speak(
			lastQ.payload.text ?? lastQ.payload.title ?? "",
			tts,
			oral
				? (shown) =>
						setReveal((r) =>
							r?.ord === lastQ.ord ? { ord: lastQ.ord, shown } : r,
						)
				: undefined,
			setVoiceState,
			() => {
				responseStartRef.current = {
					questionId: lastQ.question_id,
					at: Date.now(),
				};
				setVoiceReady(true);
			},
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lastQuestionId, tts, round?.current, round?.round_id]);

	useEffect(() => {
		if (!tts) {
			voiceCancelRef.current?.();
			window.setTimeout(() => {
				setVoiceState("idle");
				setVoiceReady(true);
			}, 0);
			window.setTimeout(() => setReveal(null), 0);
		}
	}, [tts]); // off mid-reveal → show full text

	const left = useCountdown(
		round?.time_budget_min,
		round?.started_at,
		round?.status === "active",
	);

	async function loadRound(roundId: string) {
		setErr(null);
		try {
			setRound(await api.get<RoundState>(`/rounds/${roundId}`));
		} catch (e) {
			setErr(String(e));
		}
	}

	async function exitInterview() {
		if (!round) return;
		setBusy(true);
		try {
			voiceCancelRef.current?.();
			setVoiceState("idle");
			setReveal(null);
			if (stt.state === "recording") stt.stop(true);
			await api.post(`/sessions/${sid}/exit`);
			showToast("Interview ended");
			setSession((previous) =>
				previous ? { ...previous, status: "aborted" } : previous,
			);
			setRound((previous) =>
				previous
					? { ...previous, status: "aborted", current: false }
					: previous,
			);
			setRounds((previous) =>
				previous.map((item) =>
					item.round_id === round.round_id
						? { ...item, status: "aborted", current: false }
						: item,
				),
			);
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	// "Skip to next stage": close the current round early, run its report, and let
	// the stage-complete dialog offer the proceed/later choice for the next stage.
	async function skipRound() {
		if (!round) return;
		setBusy(true);
		setErr(null);
		try {
			await api.post(`/rounds/${round.round_id}/close`);
			setRound((previous) =>
				previous ? { ...previous, status: "completed" } : previous,
			);
			await onRoundDone(round.round_id);
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function togglePause() {
		if (!session || !round || busy) return;
		setBusy(true);
		setErr(null);
		try {
			voiceCancelRef.current?.();
			setVoiceState("idle");
			setReveal(null); // paused mid-speech → show the question text in full
			if (stt.state === "recording") stt.stop(true);
			const paused = session.status !== "paused";
			await api.post(`/sessions/${sid}/${paused ? "pause" : "resume"}`);
			showToast(paused ? "Interview paused" : "Interview resumed");
			setSession((previous) =>
				previous
					? { ...previous, status: paused ? "paused" : "in_progress" }
					: previous,
			);
			setRounds(await api.get(`/sessions/${sid}/rounds`));
			setRound(await api.get<RoundState>(`/rounds/${round.round_id}`));
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function onRoundDone(rid: string) {
		// The round report is a stored artifact — if its generation fails (LLM
		// outage etc.) the interview flow must still continue; the report can be
		// regenerated later. Blocking progression on it strands the user.
		let reportFailed = false;
		try {
			await api.post(`/rounds/${rid}/report`);
		} catch {
			reportFailed = true;
		}
		let rs;
		try {
			rs = await api.get<
				{
					round_id: string;
					round_type: string;
					status: string;
					current?: boolean;
				}[]
			>(`/sessions/${sid}/rounds`);
		} catch (e) {
			setErr(String(e));
			return;
		}
		setRounds(rs);
		const next = rs.find((r) => r.status === "pending");
		if (next) {
			setNextRoundReady(true);
			showToast(
				reportFailed
					? "Round complete — the round report can be regenerated later"
					: "Round complete",
			);
		} else {
			try {
				const fr = await api.post<{ payload: Record<string, unknown> }>(
					`/sessions/${sid}/final-report`,
				);
				setFinalReport(fr.payload);
			} catch (e) {
				setErr(String(e));
			}
		}
	}

	async function send(
		text?: string,
		opts?: { retryId?: number; source?: "text" | "stt" },
	) {
		const body = (text ?? draft).trim();
		if (!round || !body) return;
		const source = opts?.source ?? "text";
		const msgId = opts?.retryId ?? nextMsgIdRef.current++;
		if (opts?.retryId == null) {
			// optimistic: the message shows in the chat immediately, before any I/O
			setDraft("");
			setPendingMsgs((p) => [
				...p,
				{ id: msgId, text: body, status: "sending", source },
			]);
		} else {
			setPendingMsgs((p) =>
				p.map((m) => (m.id === msgId ? { ...m, status: "sending" as const } : m)),
			);
		}
		setBusy(true);
		setErr(null);
		try {
			const res = await api.post<{
				round_complete: boolean;
				question?: { ord: number; text: string };
			}>(`/rounds/${round.round_id}/answer`, { text: body, source });
			const st = await api.get<RoundState>(`/rounds/${round.round_id}`);
			const persisted = st.questions.some((q) =>
				q.answers.some((a) => a.text === body),
			);
			setRound(st);
			setPendingMsgs((p) =>
				persisted
					? p.filter((m) => m.id !== msgId) // the real bubble replaces the optimistic one
					: p.map((m) => (m.id === msgId ? { ...m, status: "sent" as const } : m)),
			);
			if (res.round_complete) await onRoundDone(round.round_id);
		} catch (e) {
			// The answer endpoint can fail AFTER persisting (e.g. the evaluator/LLM
			// is down). Reconcile: if the transcript now contains the text, the
			// message was saved — show it as sent, not failed.
			let persisted = false;
			try {
				const st = await api.get<RoundState>(`/rounds/${round.round_id}`);
				persisted = st.questions.some((q) =>
					q.answers.some((a) => a.text === body),
				);
				setRound(st);
			} catch {
				/* refetch failed too — the round state stays as-is */
			}
			setPendingMsgs((p) =>
				p.map((m) =>
					m.id === msgId
						? { ...m, status: (persisted ? "sent" : "failed") as SendStatus }
						: m,
				),
			);
			if (!persisted) setErr(String(e));
		}
		setBusy(false);
	}
	async function idle(phase: "nudge" | "advance", questionId: string) {
		if (!round || busyRef.current) return;
		try {
			const res = await api.post<{
				round_complete: boolean;
				state: RoundState;
			}>(`/rounds/${round.round_id}/idle`, { question_id: questionId, phase });
			setRound(res.state);
			if (res.round_complete) await onRoundDone(round.round_id);
		} catch (e) {
			// The server is authoritative after reloads/races; stale client timers are harmless.
			if (!String(e).includes("not due") && !String(e).includes("still open")) {
				setErr(String(e));
			}
		}
	}
	useEffect(() => {
		idleRef.current = idle;
	});

	// Voice mode "Done": transcription lands in draft, then we send it immediately —
	// no preview/edit step. Cleared if transcription failed or produced nothing.
	useEffect(() => {
		if (!pendingSendRef.current || sttStateRef.current !== "idle") return;
		pendingSendRef.current = false;
		const text = draftRef.current.trim();
		if (text) void send(text, { source: "stt" });
	});

	useEffect(() => {
		const q = round?.questions.at(-1);
		const timing = q?.payload.response_window;
		if (!q || round?.status !== "active" || !voiceReady || !timing) return;
		const started =
			responseStartRef.current?.questionId === q.question_id
				? responseStartRef.current.at
				: Date.now();
		const nudged = round.idle_nudge?.question_id === q.question_id;
		const timer = window.setInterval(() => {
			const activeCandidateInput =
				!!draftRef.current.trim() ||
				sttStateRef.current !== "idle" ||
				busyRef.current;
			const elapsed = (Date.now() - started) / 1000;
			if (
				!activeCandidateInput &&
				!nudged &&
				elapsed >= timing.nudge_after_seconds
			) {
				void idleRef.current("nudge", q.question_id);
			}
			if (
				!activeCandidateInput &&
				elapsed >= timing.response_window_seconds &&
				nudged &&
				!autoSkipRef.current
			) {
				autoSkipRef.current = true;
				window.clearInterval(timer);
				void idleRef.current("advance", q.question_id);
			}
		}, 500);
		return () => window.clearInterval(timer);
		// The question count and round id are the stable identity for a newly-created turn.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		round?.round_id,
		round?.questions.length,
		round?.status,
		round?.idle_nudge,
		voiceReady,
	]);

	useEffect(() => {
		const nudge = round?.idle_nudge;
		if (!nudge || !tts) return;
		// Refetches recreate the idle_nudge object (same content, new identity) —
		// pausing must not replay a nudge the candidate already heard. Speak each
		// nudge exactly once per question, and only while the round is active.
		if (round?.status !== "active" || spokenNudgeRef.current === nudge.question_id) {
			return;
		}
		spokenNudgeRef.current = nudge.question_id;
		voiceCancelRef.current?.();
		voiceCancelRef.current = speak(nudge.text, tts, undefined, setVoiceState);
	}, [round?.idle_nudge, round?.status, tts]);

	async function nextRound() {
		setErr(null);
		setBusy(true);
		try {
			// refetch — the rounds snapshot in state can be stale after a completion
			const rs = await api.get<
				{
					round_id: string;
					round_type: string;
					status: string;
					current?: boolean;
				}[]
			>(`/sessions/${sid}/rounds`);
			setRounds(rs);
			const nx = rs.find((r) => r.status === "pending");
			if (nx) {
				await api.post(`/rounds/${nx.round_id}/open`);
				const refreshed = await api.get<
					{
						round_id: string;
						round_type: string;
						status: string;
						current?: boolean;
					}[]
				>(`/sessions/${sid}/rounds`);
				setRounds(refreshed);
				setRound(await api.get<RoundState>(`/rounds/${nx.round_id}`));
				setNextRoundReady(false);
				showToast("Next round started");
			} else {
				// all rounds done (or none were created): fall through to the final report
				const fr = await api.post<{ payload: Record<string, unknown> }>(
					`/sessions/${sid}/final-report`,
				);
				setFinalReport(fr.payload);
			}
		} catch (e) {
			setErr(String(e));
		}
		setBusy(false);
	}

	function startStt() {
		voiceCancelRef.current?.();
		setVoiceState("idle");
		setVoiceReady(true);
		setReveal(null);
		void stt.start();
	}

	// Voice "Done": stop recording, transcribe, and send the transcript instantly —
	// no preview step. The pending-send effect does the actual send once transcription lands.
	function finishSend() {
		pendingSendRef.current = true;
		stt.stop(); // transcribe; effect sends as soon as the text arrives
	}

	function switchInputMode(mode: "voice" | "text") {
		// discards any in-progress recording — it was never going to be sent by itself
		if (mode === "text" && stt.state === "recording") stt.stop(true);
		setInputMode(mode);
	}

	const stageIndex = round ? ({ A: 0, B: 1, C: 2 }[round.round_type] ?? 0) : 0;
	const stageName =
		session?.stages?.[stageIndex] ?? `Round ${round?.round_type ?? ""}`;
	const nextStageName = session?.stages?.[stageIndex + 1] ?? null;
	const showInterviewWorkspace =
		(round?.status === "active" || round?.status === "paused") &&
		!!round.current &&
		session?.status !== "completed" &&
		session?.status !== "aborted";
	const openerRecoveryNeeded =
		round?.status === "active" &&
		!!round.current &&
		round.questions.length === 0;
	const interviewOpen =
		session?.status === "in_progress" || session?.status === "paused";

	return (
		<div className="w-full interview-screen flex flex-col">
			<div className="flex items-center justify-between gap-3 border-b border-border bg-background/95 px-1 py-3">
				<div className="flex min-w-0 items-center gap-3">
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => router.push("/")}
					>
						<Home></Home>
					</Button>
					{interviewOpen && round?.current && (
						<>
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => void togglePause()}
								aria-label={
									session?.status === "paused"
										? "Resume interview"
										: "Pause interview"
								}
								title={
									session?.status === "paused"
										? "Resume interview"
										: "Pause interview"
								}
							>
								<PlayPauseIcon paused={session?.status === "paused"} />
							</Button>
						</>
					)}

					<div className="pt-2 text-xs">
						{round && !round.current ? (
							<span className="block truncate whitespace-nowrap text-neutral-500">
								previous round · read only
							</span>
						) : session?.status === "paused" ? (
							<span className="block truncate whitespace-nowrap text-amber-300">
								interview paused
							</span>
						) : round?.status !== "active" ? (
							<span className="block truncate whitespace-nowrap text-neutral-500">
								round finished
							</span>
						) : left !== null ? (
							<span
								className={
									"mt-1 flex items-center justify-between rounded-lg border px-3 py-2 font-mono text-lg font-semibold tracking-wider " +
									(left <= 150
										? "border-red-500/60 bg-red-950/50 text-red-300"
										: "border-sky-500/40 bg-sky-950/40 text-sky-200")
								}
							>
								<span>
									⏳ {String(Math.floor(left / 60)).padStart(2, "0")}:
									{String(left % 60).padStart(2, "0")}
								</span>
							</span>
						) : (
							<span className="text-neutral-500">
								budget: {round?.time_budget_min} min
							</span>
						)}
					</div>
				</div>
				{interviewOpen && (
				<div className="flex shrink-0 gap-2">
					<Button
						size="sm"
						variant="outline"
						className="border-red-900/70 text-red-300 hover:bg-red-950/40"
						disabled={busy}
						onClick={() => setEndOpen(true)}
					>
						End Interview
					</Button>
				</div>
			)}
			</div>
			<div className="grid gap-5 ">
				{/* live chat + editor */}

				{showInterviewWorkspace ? (
					<div>
						<Card className="flex min-h-[560px] flex-col hairline-panel">
							<CardHeader className="pb-2">
								<CardTitle className="text-sm">
									{stageName} · interviewer
								</CardTitle>
							</CardHeader>
							<CardContent className="flex grow flex-col gap-3">
								{session?.status === "paused" && (
									<p className="rounded-md border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
										Interview paused — the clock is stopped. Resume it from the
										button in the header.
									</p>
								)}
								<div
									ref={chatRef}
									className="max-h-[520px] grow space-y-3 overflow-y-auto pr-1"
								>
									{tells.map((t, i) => (
										<TellRow
											key={i}
											t={t}
											speakOverride={
												reveal && t.qOrd === reveal.ord
													? reveal.shown
													: undefined
											}
										/>
									))}
								{pendingMsgs.map((m) => (
									<PendingMsgRow
										key={`pending-${m.id}`}
										m={m}
										onRetry={() =>
											void send(m.text, { retryId: m.id, source: m.source })
										}
										onDismiss={() =>
											setPendingMsgs((p) => p.filter((x) => x.id !== m.id))
										}
									/>
								))}
								{(busy || voiceState !== "idle") && (
									<InterviewerActivity voiceState={voiceState} />
								)}
									{round?.idle_nudge && (
										<p className="rounded-md border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
											{round.idle_nudge.text}
										</p>
									)}
								</div>
								{err && (
									<p className="rounded-md bg-red-950/50 px-3 py-2 text-sm text-red-300">
										{err}
									</p>
								)}
								<form
									className="space-y-3"
									onSubmit={(e) => {
										e.preventDefault();
										void send();
									}}
								>
									{inputMode === "voice" ? (
										<div className="rounded-xl border border-sky-800/80 bg-sky-950/25 p-4">
											<div className="mb-3 flex items-start justify-between gap-3">
												<button
													type="button"
													className="text-xs text-neutral-400 underline underline-offset-4 hover:text-neutral-100"
													onClick={() => switchInputMode("text")}
												>
													Type instead
												</button>
											</div>
											<div className="flex flex-wrap items-center gap-3">
												{stt.state === "recording" ? (
													<>
														<Button
															className="min-h-14"
															type="button"
															onClick={() => finishSend()}
															disabled={busy}
														>
															Done
														</Button>
														<Button
															className="min-h-14 border-red-400/80 text-red-300 hover:bg-red-950/40"
															variant="outline"
															type="button"
															onClick={() => stt.stop(true)}
															disabled={busy}
														>
															Stop recording
														</Button>
														<span className="text-xs text-neutral-400">
															Listening…
														</span>
													</>
												) : (
													<>
														<button
															type="button"
															className={
																"flex min-h-14 items-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium transition-colors " +
																(stt.state === "transcribing"
																	? "border-neutral-700 bg-neutral-900 text-neutral-300"
																	: "border-sky-500/70 bg-sky-900/50 text-sky-50 hover:bg-sky-900")
															}
															onClick={() => startStt()}
															disabled={
																busy ||
																stt.state === "transcribing" ||
																round?.status !== "active" ||
																!round.current
															}
															aria-label="Start recording"
														>
															<MicIcon recording={false} />
															<span className="flex items-center gap-2">
																{stt.state === "transcribing"
																			? <><Spinner /> Preparing your words…</>
																	: "Start speaking"}
															</span>
														</button>
														<span className="text-xs text-neutral-400">
															Click on the mic to start speaking. While recording, choose Done to send
															your answer, or Stop recording to discard it and start over.
														</span>
													</>
												)}
											</div>
										</div>
									) : openerRecoveryNeeded ? (
										<Card className="flex min-h-[560px] flex-col hairline-panel">
											<CardHeader>
												<CardTitle className="text-sm">
													Interviewer is unavailable
												</CardTitle>
											</CardHeader>
											<CardContent className="flex grow flex-col items-center justify-center gap-3 text-center">
												<p className="max-w-md text-sm text-neutral-400">
													The opening question could not be generated. This is usually temporary.
												</p>
												{err && (
													<p className="max-w-md text-sm text-red-300">{err}</p>
												)}
												<Button
													onClick={async () => {
														setBusy(true);
														setErr(null);
														try {
															await api.post(`/rounds/${round.round_id}/open`);
															setRound(
																await api.get<RoundState>(`/rounds/${round.round_id}`),
															);
														} catch (e) {
															setErr(String(e));
														} finally {
															setBusy(false);
														}}}
													disabled={busy}
												>
													{busy ? "Trying again…" : "Try again"}
												</Button>
											</CardContent>
										</Card>
									) : (
										<div>
											<div className="mb-2 flex items-center justify-between">
												<span className="text-sm font-medium text-neutral-200">
													Type your answer
												</span>
												<button
													type="button"
													className="text-xs text-sky-300 underline underline-offset-4 hover:text-sky-100"
													onClick={() => switchInputMode("voice")}
												>
													Use voice
												</button>
											</div>
											<div className="flex gap-2">
												<Input
													placeholder={
														round?.status !== "active"
															? "round finished — continue to the next round"
															: "Type your answer, then press Send…"
														}
													value={draft}
													onChange={(e) => {
														const value = e.target.value;
														if (value.trim()) {
															voiceCancelRef.current?.();
															setVoiceState("idle");
															setVoiceReady(true);
															setReveal(null);
														}
														setDraft(value);
														}}
													disabled={
														busy || round?.status !== "active" || !round.current
														}
												/>
												<Button
													type="submit"
													disabled={
														busy ||
														!draft.trim() ||
														round?.status !== "active" ||
														!round.current
														}
												>
													{busy && <Spinner />}
													{busy ? "Sending…" : "Send"}
												</Button>
											</div>
										</div>
									)}
								</form>
								{finalReport && (
									<FinalSummary
										rep={finalReport}
										onOpen={() => router.push(`/reports/${sid}`)}
									/>
								)}
							</CardContent>
						</Card>

					</div>
				) : (
					<Card className="flex min-h-[560px] flex-col hairline-panel">
						<CardHeader className="pb-2">
							<CardTitle className="text-sm">Conversation history</CardTitle>
						</CardHeader>
						<CardContent className="flex grow flex-col gap-4">
							{initializing && !round ? (
								<p className="flex grow items-center justify-center gap-2 text-sm text-neutral-500" role="status">
									<Spinner /> Loading interview…
								</p>
							) : (
								<>
							<div className="flex items-start justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
								<div>
									<p className="text-sm font-medium text-neutral-200">
										{session?.status === "aborted"
											? "Interview exited"
											: round?.status === "completed"
												? "Round complete"
												: "Interview complete"}
									</p>
									<p className="mt-1 text-xs text-neutral-500">
										Read-only transcript. New responses are disabled.
									</p>
									{!finalReport &&
										round?.status === "completed" &&
										interviewOpen && (
											<Button
												className="mt-2"
												size="sm"
												onClick={() => void nextRound()}
												disabled={busy}
											>
												{busy && <Spinner />}
												{busy ? "Opening next stage…" : "Continue to next stage"}
											</Button>
										)}
								</div>
								{err && (
									<p className="rounded-md bg-red-950/50 px-3 py-2 text-sm text-red-300">
										{err}
									</p>
								)}
								{finalReport && (
									<FinalSummary
										rep={finalReport}
										onOpen={() => router.push(`/reports/${sid}`)}
									/>
								)}
							</div>
							{tells.length > 0 ? (
								<div className="max-h-[460px] grow space-y-3 overflow-y-auto pr-1">
									{tells.map((t, i) => (
										<TellRow key={i} t={t} />
									))}
								</div>
							) : (
								<p className="flex grow items-center justify-center text-sm text-neutral-500">
									No conversation was saved for this round.
								</p>
							)}
								</>
							)}
						</CardContent>
					</Card>
				)}
			</div>
			{nextRoundReady && (
				<Modal titleId="next-stage-title" title="Stage complete">
					<p className="mt-2 text-sm text-neutral-400">
						Your {stageName} responses have been saved. Continue to{" "}
						<span className="text-neutral-200">
							{nextStageName ?? "the next stage"}
						</span>{" "}
						now, or come back and take it later.
					</p>
					<div className="mt-5 flex justify-end gap-2">
						<Button variant="outline" onClick={() => setNextRoundReady(false)}>
							Take it later
						</Button>
						<Button onClick={() => void nextRound()} disabled={busy}>
							{busy && <Spinner />}
							{busy ? "Opening next stage…" : "Proceed to next stage"}
						</Button>
					</div>
				</Modal>
			)}
			{endOpen && (
				<Modal titleId="end-interview-title" title="End this interview?">
					<p className="mt-2 text-sm text-neutral-400">
						End the interview completely, or close the current stage and skip
						ahead to the next one. Everything answered so far stays in your
						report either way.
					</p>
					<div className="mt-5 flex flex-wrap justify-end gap-2">
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setEndOpen(false)}
						>
							Cancel
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => {
								setEndOpen(false);
								void skipRound();
							}}
						>
							{busy && <Spinner />}
							{busy ? "Closing stage…" : "Skip to next stage"}
						</Button>
						<Button
							variant="outline"
							className="border-red-900/70 text-red-300 hover:bg-red-950/40"
							disabled={busy}
							onClick={() => {
								setEndOpen(false);
								void exitInterview();
							}}
						>
							{busy && <Spinner />}
							{busy ? "Ending interview…" : "End interview completely"}
						</Button>
					</div>
				</Modal>
			)}
			{toast && (
				<div
					className="fixed inset-x-4 top-4 z-50 mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-lg border border-sky-800/80 bg-neutral-950 px-4 py-2 text-sm text-sky-100 shadow-xl"
					role="status"
					aria-live="polite"
				>
					{toast}
				</div>
			)}
		</div>
	);
}

// lightweight centered dialog, consistent with the app's overlay styling
function Modal({
	titleId,
	title,
	children,
}: {
	titleId: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<div
			className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 px-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			<div className="w-full max-w-md rounded-xl border border-border bg-popover p-5 shadow-2xl">
				<h2 id={titleId} className="text-base font-semibold text-neutral-100">
					{title}
				</h2>
				{children}
			</div>
		</div>
	);
}

// optimistic candidate bubble: visible instantly, with the send lifecycle on it
function PendingMsgRow({
	m,
	onRetry,
	onDismiss,
}: {
	m: PendingMsg;
	onRetry: () => void;
	onDismiss: () => void;
}) {
	return (
		<div className="ml-auto max-w-[85%] rounded-xl border border-emerald-900/60 bg-emerald-950/40 px-4 py-3">
			<p className="whitespace-pre-wrap text-sm">{m.text}</p>
			<p className="flex items-center justify-end gap-3 pt-1 text-xs">
				{m.status === "sending" && (
					<span className="animate-pulse text-neutral-500">sending…</span>
				)}
				{m.status === "sent" && (
					<span className="text-emerald-400">sent ✓</span>
				)}
				{m.status === "failed" && (
					<>
						<span className="text-red-400">failed</span>
						<button
							type="button"
							className="underline underline-offset-4 hover:text-neutral-200"
							onClick={onRetry}
						>
							retry
						</button>
						<button
							type="button"
							className="underline underline-offset-4 hover:text-neutral-200"
							onClick={onDismiss}
						>
							dismiss
						</button>
					</>
				)}
			</p>
		</div>
	);
}

function TellRow({ t, speakOverride }: { t: Tell; speakOverride?: string }) {
	if (t.who === "q")
		return (
			<div className="max-w-[85%] rounded-xl border border-border bg-neutral-900 px-4 py-3">
				{speakOverride === "" ? ( // audio starting: keep the words hidden until spoken
					<p className="text-sm text-neutral-500">🎙 …</p>
				) : (
					<pre className="whitespace-pre-wrap font-sans text-sm">
						{speakOverride ?? t.text}
					</pre>
				)}
				{t.meta && <p className="pt-1 text-xs text-neutral-500">{t.meta}</p>}
			</div>
		);
	return (
		<div className="ml-auto max-w-[85%] rounded-xl border border-emerald-900/60 bg-emerald-950/40 px-4 py-3">
			<p className="whitespace-pre-wrap text-sm">{t.text}</p>
			{t.meta && (
				<p className="pt-1 text-right text-xs text-neutral-500">{t.meta}</p>
			)}
		</div>
	);
}

function MicIcon({ recording }: { recording: boolean }) {
	return (
		<svg
			aria-hidden="true"
			className={"size-5 " + (recording ? "animate-pulse" : "")}
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			strokeWidth="1.8"
		>
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path
				d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function PlayPauseIcon({ paused }: { paused: boolean }) {
	return paused ? (
		<svg
			aria-hidden="true"
			className="size-4"
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.2-6.8a1.1 1.1 0 0 0 0-1.8L9.6 4.3C8.9 3.9 8 4.4 8 5.2Z" />
		</svg>
	) : (
		<svg
			aria-hidden="true"
			className="size-4"
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M7 5.5A1.5 1.5 0 0 1 8.5 4h1A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-1A1.5 1.5 0 0 1 7 18.5v-13Zm6 0A1.5 1.5 0 0 1 14.5 4h1A1.5 1.5 0 0 1 17 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1a1.5 1.5 0 0 1-1.5-1.5v-13Z" />
		</svg>
	);
}

function InterviewerActivity({ voiceState }: { voiceState: VoiceState }) {
	const label =
		voiceState === "loading"
			? "Interviewer is preparing a response"
			: voiceState === "speaking"
				? "Interviewer is continuing"
				: "Interviewer is thinking";

	return (
		<div
			className="flex w-fit items-center gap-2 rounded-xl border border-sky-900/70 bg-sky-950/25 px-3 py-2 text-xs text-sky-200"
			role="status"
			aria-live="polite"
			aria-label={`${label}. More of the interviewer response may follow.`}
		>
			<span>{label}</span>
			<span className="typing-dots" aria-hidden="true">
				<span />
				<span />
				<span />
			</span>
		</div>
	);
}

function FinalSummary({
	rep,
	onOpen,
}: {
	rep: Record<string, unknown>;
	onOpen: () => void;
}) {
	const overall = typeof rep.overall === "number" ? rep.overall : null;
	return (
		<div className="rounded-lg border border-border bg-neutral-900 p-4 text-sm">
			<p className="font-medium">
				Interview complete — overall {overall == null ? "–" : overall}/10
			</p>
			<Button className="mt-2" size="sm" onClick={onOpen}>
				View full report
			</Button>
		</div>
	);
}
