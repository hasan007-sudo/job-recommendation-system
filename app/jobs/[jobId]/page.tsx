"use client";

import { use, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { ParsedRound } from "../../../lib/rounds";
import { formatExperience, matchPill, initials } from "../../../lib/display";
import { getJson } from "../../../lib/api";

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
  const [matchPercent, setMatchPercent] = useState<number | undefined>(undefined);

  const { data: detail, error: queryError } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => getJson<JobDetail>(`/api/jobs/${jobId}`),
  });
  const error = queryError instanceof Error ? queryError.message : "";

  useEffect(() => {
    // The list page already computed and cached this score — reuse it. On a
    // direct link (no cached cards) there's no score, so the badge shows "—".
    try {
      const cards = JSON.parse(sessionStorage.getItem("rounds:cards") ?? "[]");
      const cached = cards.find((c: { jobId: string }) => c.jobId === jobId);
      if (typeof cached?.score === "number") {
        setMatchPercent(cached.score);
      }
    } catch {
      // no cached score — leave the badge empty
    }
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
  const meta = [job.seniority, experience].filter(Boolean);
  const pill = matchPill(matchPercent);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <section className="p-8 sm:p-10">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-[13px] font-bold text-white">
                {initials(job.companyName)}
              </div>
              <span className="text-[16px] font-semibold text-slate-500">
                {job.companyName}
              </span>
            </div>
            <h1 className="mt-5 text-[44px] font-bold leading-[1.05] tracking-tight text-slate-900">
              {job.jobTitle}
            </h1>
            {meta.length > 0 && (
              <p className="mt-3 text-[15px] text-slate-500">
                <span className="capitalize">{meta.join(" · ")}</span>
              </p>
            )}
          </div>
          {pill && (
            <div className="shrink-0 text-right">
              <div
                className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-bold ${pill.pill}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
                {matchPercent}% {pill.label}
              </div>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
                Based on your resume
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

      <div className="grid grid-cols-1 border-t border-slate-200 lg:grid-cols-2">
        <div className="border-b border-slate-200 bg-slate-50 p-8 sm:p-10 lg:border-b-0 lg:border-r">
          <Timeline rounds={job.rounds} />
        </div>
        <div className="p-8 sm:p-10">
          <Competencies groups={competencies.groups} />
        </div>
      </div>
    </div>
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
                      className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4"
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
