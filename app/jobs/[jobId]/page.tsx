"use client";

import { use, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import type { Round } from "../../../lib/rounds";
import { formatExperience, matchPill, initials } from "../../../lib/display";
import { getJson } from "../../../lib/api";

type JobDetail = {
  job: {
    jobId: string;
    jobTitle: string;
    companyName: string;
    seniority: string;
    experienceMinYears: number | null;
    experienceMaxYears: number | null;
    location: string | null;
    workMode: string | null;
    educationRequirement: string | null;
    requiredSkills: string | null;
    roleSummary: string | null;
    sourceUrl: string | null;
    fullJobDescription: string | null;
    rounds: Round[];
  };
};

const ROUND_MINUTES: Record<string, number> = {
  screening: 30,
  behavioural: 45,
  technical: 60,
  culture_fit: 45,
};

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
            <Loader2 size={18} className="animate-spin" /> Loading job…
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
  const { job } = detail;
  const experience = formatExperience(job.experienceMinYears, job.experienceMaxYears);
  const meta = [job.seniority, experience, job.location, job.workMode].filter(Boolean);
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
            {job.sourceUrl && (
              <a
                href={job.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-[0.18em] text-indigo-600 hover:text-indigo-800"
              >
                View original posting <ExternalLink size={14} />
              </a>
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

      <div className="border-t border-slate-200 bg-slate-50 p-8 sm:p-10">
        <Rounds rounds={job.rounds} />
      </div>

      {job.fullJobDescription && (
        <div className="border-t border-slate-200 p-8 sm:p-10">
          <h2 className="mb-6 text-[11px] font-bold uppercase tracking-[0.22em] text-slate-500">
            Full job description
          </h2>
          <p className="max-w-3xl whitespace-pre-wrap text-[14.5px] leading-[1.7] text-slate-700">
            {job.fullJobDescription}
          </p>
        </div>
      )}
    </div>
  );
}

function Rounds({ rounds }: { rounds: Round[] }) {
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
        <span aria-hidden className="absolute left-3.5 top-3 bottom-3 w-px bg-slate-200" />
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
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold text-slate-900">{r.title}</p>
                <p className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-500">
                  {mins} MIN
                </p>
                {r.competencies.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {r.competencies.map((c, ci) => (
                      <span
                        key={ci}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
