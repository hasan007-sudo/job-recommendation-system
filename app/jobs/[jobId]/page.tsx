"use client";

import { use, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Flag,
  Loader2,
  Phone,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { Round } from "../../../lib/rounds";
import type { GeneratedQuestion } from "../../../lib/questions";
import type { JobFitAnalysis } from "../../../lib/job-fit";
import {
  deriveSearchInput,
  type OnboardingProfile,
} from "../../../lib/onboarding";
import { formatExperience, matchPill, initials } from "../../../lib/display";
import { getJson, postJson } from "../../../lib/api";
import { InterviewSession } from "../../../components/ui/InterviewSession";

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
  screening: 10,
  behavioural: 10,
  technical: 10,
  culture_fit: 10,
};

// One-sentence candidate summary passed to the interview agent (name, degree,
// experience, target role + company) so it can personalize the greeting.
function buildUserDetails(
  profile: OnboardingProfile | null,
  job: JobDetail["job"],
): string | undefined {
  if (!profile) return undefined;

  const name = profile.name.trim() || "The candidate";

  const degree = profile.education.degree.trim();
  const major = profile.education.major.trim();
  const degreePhrase = degree
    ? `a ${degree}${major ? ` in ${major}` : ""}`
    : "";

  const expYears = profile.experienceMaxYears;
  const experiencePhrase =
    expYears > 0
      ? `${expYears} year${expYears === 1 ? "" : "s"} of experience`
      : "a fresher";

  const targetPhrase = `the ${job.jobTitle} role at ${job.companyName}`;

  const facts = [degreePhrase, experiencePhrase].filter(Boolean).join(", ");
  return `${name}${facts ? ` has ${facts}, and` : ""} is interviewing for ${targetPhrase}.`;
}

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = use(params);
  const router = useRouter();
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);

  const { data: detail, error: queryError } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => getJson<JobDetail>(`/api/jobs/${jobId}`),
  });
  const error = queryError instanceof Error ? queryError.message : "";

  // Match % is profile-relative, so it's computed server-side from the candidate's
  // skills + projects. The page reads its own profile and asks the job API — no
  // dependency on the search list or shared score state.
  const { data: matchData } = useQuery({
    queryKey: ["job-match", jobId, profile?.skills, profile?.projectKeywords],
    enabled: !!profile,
    queryFn: () => {
      const { skills, projectTexts } = deriveSearchInput(profile!);
      return postJson<{
        match?: {
          score: number | null;
          skillsPct: number | null;
          projectsPct: number | null;
        };
      }>(`/api/jobs/${jobId}/match`, { skills, projectTexts });
    },
  });
  const matchPercent = matchData?.match?.score ?? undefined;
  const skillsPct = matchData?.match?.skillsPct ?? undefined;
  const projectsPct = matchData?.match?.projectsPct ?? undefined;

  // One LLM call analyzes skills + requirements + responsibilities + nice-to-haves
  // against the resume, anchored by our match scores so the LLM's verdicts don't
  // drift from the engine. Runs once the match resolves (cached per job+profile).
  const {
    data: analysisData,
    isLoading: analysisLoading,
    error: analysisError,
  } = useQuery({
    queryKey: [
      "job-analysis",
      jobId,
      profile?.skills,
      profile?.projects,
      profile?.experience,
      matchPercent,
      skillsPct,
      projectsPct,
    ],
    enabled: !!profile && matchData !== undefined,
    queryFn: () =>
      postJson<{ analysis?: JobFitAnalysis }>(`/api/jobs/${jobId}/analysis`, {
        candidateSkills: profile!.skills,
        candidateExperience: profile!.experience,
        candidateProjects: profile!.projects,
        candidateInitiatives: (profile!.workInitiatives ?? [])
          .flat()
          .filter(Boolean),
        experienceMinYears: profile!.experienceMinYears,
        experienceMaxYears: profile!.experienceMaxYears,
        overallPct: matchPercent ?? null,
        skillsPct: skillsPct ?? null,
        projectsPct: projectsPct ?? null,
      }),
  });
  const analysis = analysisData?.analysis;
  const analysisErr =
    analysisError instanceof Error ? analysisError.message : null;

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("rounds:profile");
      if (raw) setProfile(JSON.parse(raw));
    } catch {
      // no profile — questions generated from job context only
    }
  }, [jobId]);

  return (
    <main className="min-h-screen bg-[#f5f3f7]">
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
            <span className="text-[15px] font-bold tracking-tight text-slate-900">
              Rounds
            </span>
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

        {detail && (
          <JobDetailView
            detail={detail}
            matchPercent={matchPercent}
            skillsPct={skillsPct}
            projectsPct={projectsPct}
            analysis={analysis}
            analysisLoading={analysisLoading}
            analysisError={analysisErr}
            profile={profile}
          />
        )}
      </div>
    </main>
  );
}

function JobDetailView({
  detail,
  matchPercent,
  skillsPct,
  projectsPct,
  analysis,
  analysisLoading,
  analysisError,
  profile,
}: {
  detail: JobDetail;
  matchPercent: number | undefined;
  skillsPct: number | undefined;
  projectsPct: number | undefined;
  analysis: JobFitAnalysis | undefined;
  analysisLoading: boolean;
  analysisError: string | null;
  profile: OnboardingProfile | null;
}) {
  const { job } = detail;
  const experience = formatExperience(
    job.experienceMinYears,
    job.experienceMaxYears,
  );
  const meta = [job.seniority, experience, job.location, job.workMode].filter(
    Boolean,
  );
  const pill = matchPill(matchPercent);
  const source = sourcePostingMeta(job.sourceUrl);
  const skills = (job.requiredSkills ?? "")
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="space-y-5">
      <section className="rounded-2xl bg-white p-8 sm:p-10">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-slate-500">
              {job.companyName}
            </p>
            <h1 className="mt-2 text-[44px] font-bold leading-[1.05] tracking-tight text-slate-900">
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
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-violet-50 px-3.5 py-2 text-[14px] font-bold text-violet-600 hover:text-violet-800"
              >
                <span
                  className={
                    "flex h-4 w-4 items-center justify-center rounded text-[10px] font-black text-white " +
                    source.iconClass
                  }
                >
                  {source.icon}
                </span>
                View posting <ExternalLink size={14} />
              </a>
            )}
          </div>
        </div>
        {job.roleSummary && (
          <p className="mt-6 max-w-5xl text-[16px] leading-[1.65] text-slate-500">
            {job.roleSummary}
          </p>
        )}
        {(pill || skillsPct != null || projectsPct != null) && (
          <div className="mt-6 flex flex-wrap gap-3">
            {pill && (
              <span
                className={`rounded-xl px-3.5 py-2 text-[14px] font-bold ${pill.pill}`}
              >
                {matchPercent}% {pill.label.replace("Match", "match")}
              </span>
            )}
            {skillsPct != null && (
              <span className="rounded-xl bg-slate-100 px-3.5 py-2 text-[14px] font-bold text-slate-950">
                {skillsPct}% Skills
              </span>
            )}
            {projectsPct != null && (
              <span className="rounded-xl bg-slate-100 px-3.5 py-2 text-[14px] font-bold text-slate-950">
                {projectsPct}% Projects
              </span>
            )}
          </div>
        )}
      </section>

      {profile ? (
        <JobFitSections
          analysis={analysis}
          loading={analysisLoading}
          error={analysisError}
          fallbackSkills={skills}
        />
      ) : (
        skills.length > 0 && (
          <section className="rounded-2xl bg-white p-8 sm:p-10">
            <h2 className="mb-6 text-[15px] font-bold uppercase tracking-tight text-slate-500">
              Skills
            </h2>
            <div className="flex flex-wrap gap-2">
              {skills.map((s, i) => (
                <span
                  key={i}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700"
                >
                  {s}
                </span>
              ))}
            </div>
          </section>
        )
      )}

      <section className="rounded-2xl bg-white p-8 sm:p-10">
        <Rounds rounds={job.rounds} job={job} profile={profile} />
      </section>

      {job.fullJobDescription && (
        <section className="rounded-2xl bg-white p-8 sm:p-10">
          <h2 className="mb-6 text-[15px] font-bold uppercase tracking-tight text-slate-500">
            Full job description
          </h2>
          <p className="max-w-3xl whitespace-pre-wrap text-[14.5px] leading-[1.7] text-slate-700">
            {job.fullJobDescription}
          </p>
        </section>
      )}
    </div>
  );
}

function sourcePostingMeta(sourceUrl: string | null): {
  icon: string;
  iconClass: string;
} {
  if (sourceUrl && /(^|\/\/|\.)(linkedin)\.com/i.test(sourceUrl)) {
    return { icon: "in", iconClass: "bg-[#0a66c2]" };
  }
  if (sourceUrl && /(^|\/\/|\.)(naukri)\.com/i.test(sourceUrl)) {
    return { icon: "N", iconClass: "bg-[#275df5]" };
  }
  return { icon: "↗", iconClass: "bg-slate-950" };
}

// Skills chips + the three fit accordions (Requirements / Responsibilities /
// Nice to haves), all driven by the single analysis call. While it loads we show
// the JD's required skills as plain chips so the section never looks empty.
function JobFitSections({
  analysis,
  loading,
  error,
  fallbackSkills,
}: {
  analysis: JobFitAnalysis | undefined;
  loading: boolean;
  error: string | null;
  fallbackSkills: string[];
}) {
  const skills =
    analysis?.skills ??
    fallbackSkills.map((skill) => ({ skill, matched: false }));
  const sortedSkills = [
    ...skills.filter((skill) => skill.matched),
    ...skills.filter((skill) => !skill.matched),
  ];

  return (
    <>
      {skills.length > 0 && (
        <section className="rounded-2xl bg-white p-8 sm:p-10">
          <h2 className="mb-6 text-[15px] font-bold uppercase tracking-tight text-slate-500">
            Skills
          </h2>
          <div className="flex flex-wrap gap-2">
            {sortedSkills.map((s, i) => (
              <span
                key={i}
                className={
                  "inline-flex items-center rounded-lg px-3 py-2 text-[14px] font-semibold " +
                  (s.matched
                    ? "bg-amber-50 text-orange-600"
                    : "bg-slate-100 text-slate-950")
                }
              >
                {s.skill}
              </span>
            ))}
          </div>
        </section>
      )}

      {loading && (
        <section className="rounded-2xl bg-white p-8 sm:p-10">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-500">
            <Loader2 size={15} className="animate-spin" /> Analyzing your resume
            against this role…
          </p>
        </section>
      )}

      {error && !loading && (
        <section className="rounded-2xl bg-white p-8 sm:p-10">
          <p className="text-[13px] text-rose-600">{error}</p>
        </section>
      )}

      {analysis && !loading && (
        <>
          <FitAccordion
            title="Responsibilities"
            section={analysis.responsibilities}
            defaultOpen
          />
          <FitAccordion
            title="Requirements"
            section={analysis.requirements}
            defaultOpen
          />
          <FitAccordion
            title="Nice to have"
            section={analysis.niceToHaves}
            defaultOpen
          />
        </>
      )}
    </>
  );
}

function FitAccordion({
  title,
  section,
  defaultOpen = false,
}: {
  title: string;
  section: JobFitAnalysis["requirements"];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (section.items.length === 0) return null;

  return (
    <section className="rounded-2xl bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-8 py-7 text-left sm:px-10"
      >
        <h2 className="text-[15px] font-bold uppercase tracking-tight text-slate-500">
          {title}
        </h2>
        <ChevronDown
          size={20}
          className={
            "text-slate-950 transition-transform " + (open ? "rotate-180" : "")
          }
        />
      </button>
      {open && (
        <div className="space-y-7 px-8 pb-8 sm:px-10">
          <FitGroup
            label="Strong Match"
            items={section.items.filter((item) => item.status === "found")}
            matched
          />
          <FitGroup
            label="Gap"
            items={section.items.filter((item) => item.status === "missing")}
          />
        </div>
      )}
    </section>
  );
}

function FitGroup({
  label,
  items,
  matched = false,
}: {
  label: string;
  items: JobFitAnalysis["requirements"]["items"];
  matched?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <section>
      <div
        className={
          "mb-3 flex items-center gap-2 text-[14px] font-bold " +
          (matched ? "text-emerald-700" : "text-rose-600")
        }
      >
        <Flag size={18} strokeWidth={2.25} />
        <h3>{label}</h3>
      </div>
      <ul className="space-y-3">
        {items.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-3 text-[14.5px] leading-[1.55] text-slate-600"
          >
            {matched ? (
              <CheckCircle2
                size={18}
                className="mt-0.5 shrink-0 text-emerald-500"
              />
            ) : (
              <XCircle size={18} className="mt-0.5 shrink-0 text-rose-400" />
            )}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Rounds({
  rounds,
  job,
  profile,
}: {
  rounds: Round[];
  job: JobDetail["job"];
  profile: OnboardingProfile | null;
}) {
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
        {rounds.map((r, i) => (
          <RoundItem
            key={r.position}
            round={r}
            isFirst={i === 0}
            job={job}
            profile={profile}
          />
        ))}
      </ol>
    </section>
  );
}

function RoundItem({
  round,
  isFirst,
  job,
  profile,
}: {
  round: Round;
  isFirst: boolean;
  job: JobDetail["job"];
  profile: OnboardingProfile | null;
}) {
  const [questions, setQuestions] = useState<GeneratedQuestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [session, setSession] = useState<{
    token: string;
    serverUrl: string;
  } | null>(null);

  const mins = ROUND_MINUTES[round.slug] ?? 10;

  async function startInterview() {
    if (!questions || questions.length === 0) return;
    setStarting(true);
    setStartError(null);
    try {
      const result = await postJson<{
        participant_token?: string;
        server_url?: string;
        error?: string;
      }>("/api/livekit/token", {
        jobId: job.jobId,
        roundSlug: round.slug,
        roundTitle: round.title,
        questions,
        candidateName: profile?.name,
        jobTitle: job.jobTitle,
        userDetails: buildUserDetails(profile, job),
      });
      if (result.error || !result.participant_token || !result.server_url) {
        throw new Error(result.error ?? "Failed to start interview.");
      }
      setSession({
        token: result.participant_token,
        serverUrl: result.server_url,
      });
    } catch (e) {
      setStartError(
        e instanceof Error ? e.message : "Failed to start interview.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function generate() {
    setLoading(true);
    setGenError(null);
    try {
      const result = await postJson<{
        questions?: GeneratedQuestion[];
        error?: string;
      }>(`/api/jobs/${job.jobId}/questions`, {
        roundSlug: round.slug,
        roundTitle: round.title,
        competencies: round.competencies,
        jobTitle: job.jobTitle,
        requiredSkills: job.requiredSkills,
        roleSummary: job.roleSummary,
        ...(profile
          ? {
              candidateSkills: profile.skills,
              candidateExperience: profile.experience,
              candidateProjects: profile.projects,
              experienceMinYears: profile.experienceMinYears,
              experienceMaxYears: profile.experienceMaxYears,
            }
          : {}),
      });
      if (result.error) throw new Error(result.error);
      setQuestions(result.questions ?? []);
    } catch (e) {
      setGenError(
        e instanceof Error ? e.message : "Failed to generate questions.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="relative flex gap-5">
      <span
        className={
          "relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold " +
          (isFirst
            ? "bg-slate-900 text-white"
            : "border border-slate-200 bg-white text-slate-500")
        }
      >
        {round.position}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-bold text-slate-900">{round.title}</p>
        <p className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-500">
          {mins} MIN
        </p>
        {round.competencies.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {round.competencies.map((c, ci) => (
              <span
                key={ci}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700"
              >
                {c}
              </span>
            ))}
          </div>
        )}

        <div className="mt-4">
          {questions === null && !loading && (
            <button
              onClick={generate}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-[13px] font-bold uppercase tracking-[0.18em] text-white hover:bg-slate-700 active:bg-slate-800"
            >
              <Sparkles size={13} />
              Generate questions
            </button>
          )}

          {loading && (
            <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-500">
              <Loader2 size={13} className="animate-spin" />
              Generating…
            </p>
          )}

          {genError && <p className="text-[13px] text-rose-600">{genError}</p>}

          {questions !== null && questions.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <ol className="space-y-3">
                {questions.map((q, qi) => (
                  <li key={q.id} className="flex gap-3">
                    <span className="mt-0.5 text-[11px] font-bold tabular-nums text-indigo-500">
                      {String(qi + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[14px] leading-[1.6] text-slate-700">
                      {q.text}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="mt-5 flex items-center gap-4">
                <button
                  onClick={startInterview}
                  disabled={starting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-indigo-600 px-4 text-[13px] font-bold uppercase tracking-[0.18em] text-white hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60"
                >
                  {starting ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Phone size={13} />
                  )}
                  {starting ? "Starting…" : "Start interview"}
                </button>
                <button
                  onClick={generate}
                  className="text-[12px] font-bold uppercase tracking-[0.18em] text-indigo-600 hover:text-indigo-800"
                >
                  Regenerate
                </button>
              </div>
              {startError && (
                <p className="mt-3 text-[13px] text-rose-600">{startError}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {session && (
        <InterviewSession
          token={session.token}
          serverUrl={session.serverUrl}
          roundTitle={round.title}
          jobTitle={job.jobTitle}
          onClose={() => setSession(null)}
        />
      )}
    </li>
  );
}
