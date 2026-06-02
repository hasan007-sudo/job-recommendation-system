"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { ParsedRound } from "../../../lib/rounds";
import { formatExperience, tierFor } from "../../../lib/display";
import { requestMatchScores } from "../../../lib/match-client";

type Item = { title: string; description: string };
type Group = { name: string; items: Item[] };

type JobDetail = {
  job: {
    jobId: string;
    jobTitle: string;
    companyName: string;
    seniority: string;
    experienceMinYears: number | null;
    experienceMaxYears: number | null;
    rounds: ParsedRound[];
    roleSummary: string | null;
  };
  competencies: { groups: Group[] };
};

const ROUND_MINUTES: Record<string, number> = {
  opening: 30,
  technical: 60,
  system_design: 75,
  behavioral: 45,
  domain: 45,
  final: 45,
  other: 45,
};

function groupTone(name: string): { label: string; color: string } {
  const n = name.toLowerCase();
  if (n.includes("behavior") || n.includes("soft")) {
    return { label: "BEHAVIORAL / SOFT", color: "text-emerald-500" };
  }
  if (n.includes("problem") || n.includes("delivery")) {
    return { label: "PROBLEM-SOLVING & DELIVERY", color: "text-amber-500" };
  }
  if (n.includes("technical")) {
    return { label: "TECHNICAL", color: "text-indigo-500" };
  }
  return { label: name.toUpperCase(), color: "text-indigo-500" };
}

export default function JobDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  const router = useRouter();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [matchPercent, setMatchPercent] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not load job.");
        if (!cancelled) setDetail(data);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    // The list page already computed and cached this score — reuse it and skip
    // the network round-trip when it's available.
    try {
      const cards = JSON.parse(sessionStorage.getItem("rounds:cards") ?? "[]");
      const cached = cards.find((c: { jobId: string }) => c.jobId === jobId);
      if (typeof cached?.matchPercent === "number") {
        setMatchPercent(cached.matchPercent);
        return;
      }
    } catch {
      // fall through to the API
    }

    const raw = sessionStorage.getItem("rounds:profile");
    if (!raw) return;
    let cancelled = false;
    try {
      const profile = JSON.parse(raw);
      requestMatchScores(profile.resumeText ?? "", [jobId]).then((scores) => {
        if (!cancelled && typeof scores[jobId] === "number") {
          setMatchPercent(scores[jobId]);
        }
      });
    } catch {
      // ignore
    }
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <button
            onClick={() => router.push("/")}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-500 hover:text-slate-900"
          >
            <ArrowLeft size={14} /> Back to matches
          </button>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-slate-900" />
            <span className="text-[15px] font-bold tracking-tight text-slate-900">Rounds</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-10">
        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-rose-700">
            {error}
          </div>
        )}

        {!error && !detail && (
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-8 text-slate-500">
            <Loader2 size={18} className="animate-spin" /> Analyzing job description…
          </div>
        )}

        {detail && <JobDetailView detail={detail} matchPercent={matchPercent} />}
      </div>
    </main>
  );
}

function JobDetailView({
  detail,
  matchPercent,
}: {
  detail: JobDetail;
  matchPercent: number | undefined;
}) {
  const { job, competencies } = detail;
  const experience = formatExperience(job.experienceMinYears, job.experienceMaxYears);
  const tier = tierFor(matchPercent);

  return (
    <>
      <section className="border-b border-slate-200 pb-8">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-[44px] font-bold leading-[1.05] tracking-tight text-slate-900">
              {job.jobTitle}
            </h1>
            <p className="mt-3 text-[15px] text-slate-500">
              {job.companyName} · <span className="capitalize">{job.seniority}</span>
              {experience ? ` · ${experience}` : ""}
            </p>
          </div>
          {tier && (
            <div className="shrink-0 text-right">
              <p className={`text-[36px] font-bold leading-none ${tier.color}`}>
                {matchPercent}%
              </p>
              <p className={`mt-1 text-[11px] font-bold uppercase tracking-[0.18em] ${tier.color}`}>
                {tier.label}
              </p>
            </div>
          )}
        </div>
        {job.roleSummary && (
          <p className="mt-6 max-w-3xl text-[16px] leading-[1.65] text-slate-800">
            {job.roleSummary}
          </p>
        )}
      </section>

      <div className="mt-10 grid grid-cols-1 gap-12 lg:grid-cols-2">
        <Timeline rounds={job.rounds} />
        <Competencies groups={competencies.groups} />
      </div>
    </>
  );
}

function Timeline({ rounds }: { rounds: ParsedRound[] }) {
  return (
    <section>
      <div className="mb-6 flex items-end justify-between">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">
          Interview process
        </h2>
        <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">
          {rounds.length} Rounds
        </span>
      </div>
      <ol className="relative space-y-7">
        <span
          aria-hidden
          className="absolute left-3.5 top-3 bottom-3 w-px bg-slate-200"
        />
        {rounds.map((r, i) => {
          const mins = ROUND_MINUTES[r.slug] ?? 45;
          const isFirst = i === 0;
          return (
            <li key={r.position} className="relative flex gap-5">
              <span
                className={
                  "relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold " +
                  (isFirst
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 bg-white text-slate-500")
                }
              >
                {r.position}
              </span>
              <div>
                <p className="text-[15px] font-bold text-slate-900">{r.title}</p>
                <p className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-500">
                  {mins} MIN
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Competencies({ groups }: { groups: Group[] }) {
  return (
    <section>
      <h2 className="mb-6 text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">
        Core competencies
      </h2>
      {groups.length === 0 ? (
        <p className="text-[13px] text-slate-500">
          No competencies generated — the job description was too short.
        </p>
      ) : (
        <div className="space-y-8">
          {groups.map((group, gi) => {
            const tone = groupTone(group.name);
            return (
              <div key={gi}>
                <h3
                  className={`mb-3 text-[12px] font-bold uppercase tracking-[0.18em] ${tone.color}`}
                >
                  {tone.label}
                </h3>
                <div className="space-y-3">
                  {group.items.map((it, ii) => (
                    <div
                      key={ii}
                      className="rounded-xl border border-slate-200 bg-white px-5 py-4"
                    >
                      <p className="text-[15px] font-bold text-slate-900">{it.title}</p>
                      {it.description && (
                        <p className="mt-1 text-[13.5px] leading-[1.55] text-slate-500">
                          {it.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
