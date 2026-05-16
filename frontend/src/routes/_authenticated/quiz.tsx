import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabase";
import { Loader2, Brain, CheckCircle2, XCircle } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = "https://nurseprep-mvp-production.up.railway.app";
const API_KEY = "nurseprep_secret_123";
const LS_KEY = "nurseprep_quiz_results";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnswerChoice {
  id: string;
  letter?: string;
  text: string;
}

interface Question {
  id: string;
  question_text: string;
  answer_choices: AnswerChoice[] | Record<string, string>;
  correct_answer: string;
  question_type?: string;
  rationale?: string;
  trap_explanations?: Record<string, string>;
  clinical_pearl?: string;
  nclex_framework?: string;
}

interface QuizRecord {
  questionId: string;
  framework: string;
  selected: string;
  correct: boolean;
  question: Question;
  choices: AnswerChoice[];
}

interface AIReviewData {
  overall: string;
  strong_areas: string[];
  weak_areas: string[];
  focus_tips: { topic: string; tip: string }[];
  next_steps: string;
}

interface TopicStat {
  topic: string;
  correct: number;
  total: number;
  items: QuizRecord[];
  pct: number;
}

interface PersistedResults {
  records: QuizRecord[];
  total: number;
  score: number;
  topicBreakdown: TopicStat[];
  completedAt: string;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/_authenticated/quiz")({
  component: QuizPage,
  validateSearch: (s: Record<string, unknown>) => ({
    document: typeof s.document === "string" ? s.document : undefined,
  }),
  head: () => ({ meta: [{ title: "Quiz — NursePrep" }] }),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const n = [...arr];
  for (let i = n.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [n[i], n[j]] = [n[j], n[i]];
  }
  return n;
}

function normaliseChoices(raw: Question["answer_choices"]): AnswerChoice[] {
  const labels = ["A", "B", "C", "D", "E", "F"];
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item, idx) => {
      if (typeof item === "string") return { id: labels[idx], text: item };
      const id =
        (item as AnswerChoice).id ??
        (item as { letter?: string }).letter ??
        labels[idx];
      return { id, text: (item as AnswerChoice).text ?? "" };
    });
  }
  return Object.entries(raw).map(([id, text]) => ({ id, text: String(text) }));
}

function saveResultsToLocalStorage(payload: PersistedResults): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota errors
  }
}

function loadResultsFromLocalStorage(): PersistedResults | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedResults) : null;
  } catch {
    return null;
  }
}

// ─── Main quiz page ───────────────────────────────────────────────────────────

function QuizPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { document: documentId } = Route.useSearch();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId] = useState(() => crypto.randomUUID());

  const [currentIndex, setCurrentIndex] = useState(0);
  // phase: "answering" | "reviewing" | "complete"
  const [phase, setPhase] = useState<"answering" | "reviewing" | "complete">(
    "answering"
  );

  // MCQ: single selected choice id
  const [selected, setSelected] = useState<string | null>(null);
  // SATA: multiple selected choice ids
  const [sataSelected, setSataSelected] = useState<string[]>([]);
  // Accumulated answer records
  const [records, setRecords] = useState<QuizRecord[]>([]);
  // Ref to always have the latest records without stale closure issues
  const recordsRef = useRef<QuizRecord[]>([]);

  // Fetch questions on mount
  useEffect(() => {
    if (!documentId) {
      setError("No document selected.");
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error: err } = await supabase
        .from("questions")
        .select(
          "id, question_text, answer_choices, correct_answer, rationale, trap_explanations, clinical_pearl, nclex_framework, question_type"
        )
        .eq("document_id", documentId);
      if (err) {
        setError(err.message);
      } else {
        setQuestions(shuffle(data ?? []));
      }
      setLoading(false);
    })();
  }, [documentId]);

  const question = questions[currentIndex];
  const isSata =
    question && (question.question_type ?? "").toLowerCase() === "sata";
  const choices = question ? normaliseChoices(question.answer_choices) : [];

  // Compute canonical answer strings for comparison
  const selectedStr = isSata
    ? [...sataSelected].sort().join(",")
    : selected ?? "";
  const correctStr = isSata
    ? (question?.correct_answer ?? "")
        .split(/[,\s]+/)
        .filter(Boolean)
        .sort()
        .join(",")
    : (question?.correct_answer ?? "");

  const hasSelection = isSata ? sataSelected.length > 0 : selected !== null;

  // Submit answer for current question
  const handleSubmit = async () => {
    if (!hasSelection || !question) return;
    const isCorrect = selectedStr === correctStr;
    const framework = question.nclex_framework ?? "General";

    const newRecord: QuizRecord = {
      questionId: question.id,
      framework,
      selected: selectedStr,
      correct: isCorrect,
      question,
      choices,
    };

    // Add record FIRST before state transition; keep ref in sync
    const updatedRecords = [...recordsRef.current, newRecord];
    recordsRef.current = updatedRecords;
    setRecords(updatedRecords);
    setPhase("reviewing");

    // Fire-and-forget Supabase analytics (non-blocking, non-crashing)
    if (user) {
      try {
        await supabase.from("quiz_responses").insert({
          session_id: sessionId,
          question_id: question.id,
          selected_answer: selectedStr,
          is_correct: isCorrect,
          user_id: user.id,
        });
        const { data: existing } = await supabase
          .from("topic_performance")
          .select("id, total_attempts, correct_count")
          .eq("user_id", user.id)
          .eq("nclex_framework", framework)
          .maybeSingle();
        if (existing) {
          await supabase
            .from("topic_performance")
            .update({
              total_attempts: (existing.total_attempts ?? 0) + 1,
              correct_count: (existing.correct_count ?? 0) + (isCorrect ? 1 : 0),
            })
            .eq("id", existing.id);
        } else {
          await supabase.from("topic_performance").insert({
            user_id: user.id,
            nclex_framework: framework,
            total_attempts: 1,
            correct_count: isCorrect ? 1 : 0,
          });
        }
      } catch {
        // Analytics failures should never crash the quiz
      }
    }
  };

  // Advance to next question or complete the quiz.
  // Always reads from recordsRef to avoid stale-closure issues with
  // the records state that was just updated in handleSubmit.
  const handleNext = useCallback(() => {
    if (currentIndex + 1 >= questions.length) {
      // Read the latest records from the ref — guaranteed fresh
      const currentRecords = recordsRef.current;

      // ── Save results to localStorage BEFORE state transition ──
      const correctCount = currentRecords.filter((r) => r.correct).length;
      const total = questions.length;
      const score = total > 0 ? Math.round((correctCount / total) * 100) : 0;

      const topicMap = new Map<
        string,
        { correct: number; total: number; items: QuizRecord[] }
      >();
      for (const rec of currentRecords) {
        const entry = topicMap.get(rec.framework) ?? {
          correct: 0,
          total: 0,
          items: [],
        };
        entry.total += 1;
        if (rec.correct) entry.correct += 1;
        entry.items.push(rec);
        topicMap.set(rec.framework, entry);
      }
      const topicBreakdown: TopicStat[] = Array.from(topicMap.entries()).map(
        ([topic, s]) => ({
          topic,
          correct: s.correct,
          total: s.total,
          items: s.items,
          pct: s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
        })
      );

      const payload: PersistedResults = {
        records: currentRecords,
        total,
        score,
        topicBreakdown,
        completedAt: new Date().toISOString(),
      };
      saveResultsToLocalStorage(payload);
      setPhase("complete");
    } else {
      setCurrentIndex((i) => i + 1);
      setSelected(null);
      setSataSelected([]);
      setPhase("answering");
    }
  }, [currentIndex, questions.length]);

  // Restart quiz with reshuffled questions
  const handleAnother = () => {
    recordsRef.current = [];
    setRecords([]);
    setQuestions((q) => shuffle(q));
    setCurrentIndex(0);
    setSelected(null);
    setSataSelected([]);
    setPhase("answering");
  };

  // ── Render: loading ──
  if (loading) {
    return (
      <main className="mx-auto flex max-w-xl flex-col items-center px-6 py-24 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-secondary" />
        <p className="mt-4 text-muted-foreground">Loading your questions…</p>
      </main>
    );
  }

  // ── Render: error / empty ──
  if (error || questions.length === 0) {
    return (
      <main className="mx-auto max-w-xl px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">No questions available</h1>
        <p className="mt-2 text-muted-foreground">
          {error ?? "This document has no questions yet."}
        </p>
        <button
          onClick={() => navigate({ to: "/dashboard" })}
          className="mt-6 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          Back to Dashboard
        </button>
      </main>
    );
  }

  // ── Render: complete ──
  if (phase === "complete") {
    return (
      <QuizResults
        records={records}
        total={questions.length}
        onAnother={handleAnother}
        onDashboard={() => navigate({ to: "/dashboard" })}
      />
    );
  }

  // ── Render: answering / reviewing ──
  const isReviewing = phase === "reviewing";
  const isCorrect = isReviewing && selectedStr === correctStr;
  const isLast = currentIndex + 1 >= questions.length;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-muted-foreground">
          Question {currentIndex + 1} of {questions.length}
        </span>
        {question.nclex_framework && (
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {question.nclex_framework}
          </span>
        )}
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-secondary transition-all"
          style={{
            width: `${((currentIndex + (isReviewing ? 1 : 0)) / questions.length) * 100}%`,
          }}
        />
      </div>

      <h1 className="mt-8 text-2xl font-semibold leading-snug tracking-tight sm:text-3xl">
        {question.question_text}
      </h1>

      <ul className="mt-8 space-y-3">
        {choices.map((choice) => {
          const isSelected = isSata
            ? sataSelected.includes(choice.id)
            : selected === choice.id;
          const isCorrectChoice = correctStr
            .split(",")
            .includes(choice.id);
          let cls =
            "border-border bg-card hover:border-secondary/60";
          if (isReviewing) {
            if (isCorrectChoice) cls = "border-secondary bg-secondary/15";
            else if (isSelected)
              cls = "border-destructive bg-destructive/10";
            else cls = "border-border bg-card opacity-70";
          } else if (isSelected) {
            cls = "border-secondary bg-secondary/15";
          }
          return (
            <li key={choice.id}>
              <button
                type="button"
                disabled={isReviewing}
                onClick={() => {
                  if (isSata) {
                    setSataSelected((prev) =>
                      prev.includes(choice.id)
                        ? prev.filter((id) => id !== choice.id)
                        : [...prev, choice.id]
                    );
                  } else {
                    setSelected(choice.id);
                  }
                }}
                className={`flex w-full items-start gap-4 rounded-xl border-2 px-5 py-4 text-left transition-colors ${cls}`}
              >
                <div
                  className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-2 text-sm font-semibold ${
                    isSelected
                      ? "border-secondary bg-secondary text-primary"
                      : "border-border bg-background text-muted-foreground"
                  }`}
                >
                  {choice.id}
                </div>
                <span className="text-base leading-relaxed">{choice.text}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {!isReviewing && (
        <button
          disabled={!hasSelection}
          onClick={handleSubmit}
          className="mt-8 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Submit Answer
        </button>
      )}

      {isReviewing && (
        <AnswerReview
          question={question}
          choices={choices}
          isCorrect={isCorrect}
          selected={selectedStr}
          isLast={isLast}
          onNext={handleNext}
        />
      )}
    </main>
  );
}

// ─── Answer review panel ──────────────────────────────────────────────────────

function AnswerReview({
  question,
  choices,
  isCorrect,
  selected,
  isLast,
  onNext,
}: {
  question: Question;
  choices: AnswerChoice[];
  isCorrect: boolean;
  selected: string;
  isLast: boolean;
  onNext: () => void;
}) {
  const trapExplanations = question.trap_explanations ?? {};

  const formatAnswer = (ids: string) =>
    choices
      .filter((c) => ids.split(",").includes(c.id))
      .map((c) => `${c.id}. ${c.text}`)
      .join("  •  ") || ids;

  return (
    <div className="mt-10 space-y-6">
      <div
        className={`flex items-center gap-3 rounded-xl border-2 px-5 py-4 ${
          isCorrect
            ? "border-secondary bg-secondary/15"
            : "border-destructive bg-destructive/10"
        }`}
      >
        {isCorrect ? (
          <CheckCircle2 className="h-6 w-6 text-secondary" />
        ) : (
          <XCircle className="h-6 w-6 text-destructive" />
        )}
        <div>
          <p className="font-semibold">{isCorrect ? "Correct" : "Not quite"}</p>
          <p className="text-sm text-muted-foreground">
            Correct answer: {question.correct_answer}
          </p>
        </div>
      </div>

      {question.rationale && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Rationale
          </h3>
          <p className="mt-2 leading-relaxed">{question.rationale}</p>
        </div>
      )}

      {Object.keys(trapExplanations).length > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Why the wrong answers are tempting
          </h3>
          <ul className="mt-3 space-y-3">
            {choices
              .filter(
                (c) =>
                  c.id !== question.correct_answer && trapExplanations[c.id]
              )
              .map((c) => (
                <li key={c.id} className="flex gap-3">
                  <span
                    className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-semibold ${
                      selected === c.id
                        ? "bg-destructive text-destructive-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {c.id}
                  </span>
                  <p className="text-sm leading-relaxed">
                    {trapExplanations[c.id]}
                  </p>
                </li>
              ))}
          </ul>
        </div>
      )}

      {question.clinical_pearl && (
        <div className="rounded-xl border border-secondary/30 bg-secondary/10 p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Clinical pearl
          </h3>
          <p className="mt-2 leading-relaxed">{question.clinical_pearl}</p>
        </div>
      )}

      {question.nclex_framework && (
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          NCLEX framework: {question.nclex_framework}
        </p>
      )}

      <button
        onClick={onNext}
        className="rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        {isLast ? "See Results" : "Next Question"}
      </button>
    </div>
  );
}

// ─── Quiz results ─────────────────────────────────────────────────────────────

function QuizResults({
  records: propRecords,
  total: propTotal,
  onAnother,
  onDashboard,
}: {
  records: QuizRecord[];
  total: number;
  onAnother: () => void;
  onDashboard: () => void;
}) {
  // Fallback: if records are empty (e.g. after a page refresh), read from localStorage
  const persisted = useMemo<PersistedResults | null>(() => {
    if (propRecords.length > 0) return null;
    return loadResultsFromLocalStorage();
  }, [propRecords.length]);

  const records = propRecords.length > 0 ? propRecords : (persisted?.records ?? []);
  const total = propRecords.length > 0 ? propTotal : (persisted?.total ?? propTotal);

  const correctCount = records.filter((r) => r.correct).length;
  const score = total > 0 ? Math.round((correctCount / total) * 100) : 0;

  const byTopic: TopicStat[] = useMemo(() => {
    const topicMap = new Map<
      string,
      { correct: number; total: number; items: QuizRecord[] }
    >();
    for (const rec of records) {
      const entry = topicMap.get(rec.framework) ?? {
        correct: 0,
        total: 0,
        items: [],
      };
      entry.total += 1;
      if (rec.correct) entry.correct += 1;
      entry.items.push(rec);
      topicMap.set(rec.framework, entry);
    }
    return Array.from(topicMap.entries()).map(([topic, s]) => ({
      topic,
      correct: s.correct,
      total: s.total,
      items: s.items,
      pct: s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
    }));
  }, [records]);

  const formatAnswer = (ids: string, choices: AnswerChoice[]) =>
    choices
      .filter((c) => ids.split(",").includes(c.id))
      .map((c) => `${c.id}. ${c.text}`)
      .join("  •  ") || ids;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Quiz complete</h1>
      <p className="mt-2 text-muted-foreground">
        Focus your next session on the topics below 70%.
      </p>

      <div className="mt-8 rounded-2xl border border-border bg-card p-8 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Score
        </p>
        <p className="mt-2 text-5xl font-bold tracking-tight">{score}%</p>
        <p className="mt-1 text-muted-foreground">
          {correctCount} of {total} correct
        </p>
      </div>

      <AIReview pct={score} byTopic={byTopic} />

      {byTopic.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">
            By NCLEX topic
          </h2>
          <Accordion
            type="multiple"
            className="mt-4 divide-y divide-border rounded-2xl border border-border bg-card"
          >
            {byTopic.map((stat) => {
              const isBelowThreshold = stat.pct < 70;
              return (
                <AccordionItem
                  key={stat.topic}
                  value={stat.topic}
                  className="border-b-0 px-4 sm:px-5"
                >
                  <AccordionTrigger className="py-4 hover:no-underline">
                    <div className="flex flex-1 items-center justify-between gap-3 pr-3">
                      <span className="font-medium text-left">
                        {stat.topic} — {stat.correct}/{stat.total} correct
                      </span>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${
                          isBelowThreshold
                            ? "bg-destructive/15 text-destructive"
                            : "bg-secondary/20 text-primary"
                        }`}
                      >
                        {stat.pct}%
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <ul className="space-y-4 pb-2">
                      {stat.items.map((rec) => (
                        <li
                          key={rec.questionId}
                          className="rounded-lg border border-border bg-background p-4"
                        >
                          <div className="flex items-start gap-2">
                            {rec.correct ? (
                              <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-emerald-600" />
                            ) : (
                              <XCircle className="mt-0.5 h-5 w-5 flex-none text-destructive" />
                            )}
                            <p className="text-sm font-medium leading-snug">
                              {rec.question.question_text}
                            </p>
                          </div>
                          <dl className="mt-3 space-y-1.5 pl-7 text-sm">
                            <div>
                              <dt className="inline text-muted-foreground">
                                Your answer:{" "}
                              </dt>
                              <dd className="inline font-medium">
                                {formatAnswer(rec.selected, rec.choices)}
                              </dd>
                            </div>
                            <div>
                              <dt className="inline text-muted-foreground">
                                Correct answer:{" "}
                              </dt>
                              <dd className="inline font-medium">
                                {formatAnswer(
                                  rec.question.correct_answer ?? "",
                                  rec.choices
                                )}
                              </dd>
                            </div>
                          </dl>
                          {rec.question.rationale && (
                            <p className="mt-3 pl-7 text-sm leading-relaxed text-muted-foreground">
                              {rec.question.rationale}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-3">
        <button
          onClick={onAnother}
          className="rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition-opacity hover:opacity-90"
        >
          Take Another Quiz
        </button>
        <button
          onClick={onDashboard}
          className="rounded-lg border border-border bg-background px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-muted"
        >
          Back to Dashboard
        </button>
      </div>
    </main>
  );
}

// ─── AI Review (study plan) ───────────────────────────────────────────────────

function AIReview({
  pct,
  byTopic,
}: {
  pct: number;
  byTopic: TopicStat[];
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [review, setReview] = useState<AIReviewData | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // Prevent setState calls after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchReview = useCallback(async () => {
    if (!mountedRef.current) return;
    setIsLoading(true);
    setReviewError(null);
    setReview(null);

    // Always wrapped in try/catch — AI review failure must never crash the page
    try {
      const strongTopics = byTopic.filter((t) => t.pct >= 70).map((t) => t.topic);
      const weakTopics   = byTopic.filter((t) => t.pct  < 70).map((t) => t.topic);
      const scoresByTopic: Record<string, { correct: number; total: number }> = {};
      for (const t of byTopic) {
        scoresByTopic[t.topic] = { correct: t.correct, total: t.total };
      }

      const response = await fetch(`${API_BASE}/ai-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          total_score: pct,
          strong_topics: strongTopics,
          weak_topics: weakTopics,
          scores_by_topic: scoresByTopic,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (!data.review) throw new Error("No review in response");

      if (mountedRef.current) setReview(data.review as AIReviewData);
    } catch (err) {
      if (mountedRef.current)
        setReviewError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [pct, byTopic]);

  useEffect(() => { fetchReview(); }, [fetchReview]);

  return (
    <div
      className="mt-6 rounded-2xl border-l-4 p-8"
      style={{ backgroundColor: "#E8F8F5", borderLeftColor: "#2DD4BF" }}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: "#2DD4BF" }}
        >
          <Brain className="h-5 w-5" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-primary">
          Your Study Plan
        </h2>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="mt-6 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Getting your personalized feedback…
        </div>
      )}

      {/* Error */}
      {!isLoading && reviewError && (
        <div className="mt-6 space-y-3">
          <p className="text-muted-foreground">
            Could not load AI feedback. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={fetchReview}
            className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {/* Structured review */}
      {!isLoading && !reviewError && review && (
        <div className="mt-6 space-y-6">

          {/* Overall */}
          {review.overall && (
            <p className="text-lg font-medium leading-relaxed text-foreground">
              {review.overall}
            </p>
          )}

          {/* Strong / Weak area badges */}
          {(review.weak_areas?.length > 0 || review.strong_areas?.length > 0) && (
            <div className="space-y-4">
              {review.weak_areas?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Focus Areas
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {review.weak_areas.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-rose-100 px-3 py-1 text-xs font-medium text-rose-700"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {review.strong_areas?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Strong Areas
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {review.strong_areas.map((t) => (
                      <span
                        key={t}
                        className="rounded-full px-3 py-1 text-xs font-medium"
                        style={{ backgroundColor: "#CCF5EC", color: "#0F766E" }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Focus tips — one card per topic */}
          {review.focus_tips?.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Study Tips
              </p>
              {review.focus_tips.map((ft) => (
                <div
                  key={ft.topic}
                  className="rounded-xl border border-border bg-white px-5 py-4"
                >
                  <p className="text-sm font-semibold text-foreground">{ft.topic}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {ft.tip}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Next steps — highlighted teal box */}
          {review.next_steps && (
            <div
              className="rounded-xl px-5 py-4"
              style={{ backgroundColor: "#2DD4BF1A", border: "1px solid #2DD4BF66" }}
            >
              <p className="text-xs font-semibold uppercase tracking-wide"
                 style={{ color: "#0F766E" }}>
                Next Steps
              </p>
              <p className="mt-1 text-sm font-medium leading-relaxed text-foreground">
                {review.next_steps}
              </p>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
