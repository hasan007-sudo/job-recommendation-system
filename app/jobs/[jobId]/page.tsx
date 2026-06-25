"use client";

import { use, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Blocks,
  CheckCircle2,
  Goal,
  Loader2,
  Phone,
  Play,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { Round } from "../../../lib/rounds";
import type { GeneratedQuestion } from "../../../lib/questions";
import type { JobFitAnalysis } from "../../../lib/job-fit";
import { type OnboardingProfile } from "../../../lib/onboarding";
import { formatExperience } from "../../../lib/display";
import { postJson } from "../../../lib/api";
import { InterviewSession } from "../../../components/ui/InterviewSession";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../../components/shadcn/accordion";
import { Badge } from "../../../components/shadcn/badge";
import { Button } from "../../../components/shadcn/button";
import { Card, CardContent } from "../../../components/shadcn/card";
import {
  type JobDetail,
  useJobAnalysis,
  useJobDetail,
  useJobMatch,
} from "../../../hooks/use-job-detail";

const ROUND_MINUTES: Record<string, number> = {
  screening: 10,
  behavioural: 10,
  technical: 10,
  culture_fit: 10,
};

type DetailStep = "match-details" | "round-list";

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
  const searchParams = useSearchParams();
  const step = getDetailStep(searchParams.get("step"));
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);

  const { data: detail, error: queryError } = useJobDetail(jobId);
  const error = queryError instanceof Error ? queryError.message : "";

  const { data: matchData } = useJobMatch(jobId, profile);
  const matchPercent = matchData?.match?.score ?? undefined;
  const skillsPct = matchData?.match?.skillsPct ?? undefined;
  const projectsPct = matchData?.match?.projectsPct ?? undefined;

  const {
    data: analysisData,
    isLoading: analysisLoading,
    error: analysisError,
  } = useJobAnalysis({
    jobId,
    match: matchData,
    profile,
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

  useEffect(() => {
    if (searchParams.get("step")) return;
    const url = new URL(window.location.href);
    url.searchParams.set("step", "match-details");
    router.replace(url.pathname + url.search, { scroll: false });
  }, [router, searchParams]);

  return (
    <main className="min-h-screen bg-[#f5f3f7]">
      <div className="mx-auto max-w-6xl px-5 py-5 sm:px-8">
        {error && (
          <Card className="rounded-2xl border-rose-200 bg-rose-50">
            <CardContent className="p-5 text-rose-700">{error}</CardContent>
          </Card>
        )}

        {!error && !detail && (
          <Card className="rounded-xl border-slate-200 bg-white">
            <CardContent className="flex items-center gap-2 px-5 py-8 text-slate-500">
              <Loader2 size={18} className="animate-spin" /> Loading job…
            </CardContent>
          </Card>
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
            step={step}
            onStepChange={(s) => {
              const url = new URL(window.location.href);
              url.searchParams.set("step", s);
              router.push(url.pathname + url.search);
            }}
            onBackToMatches={() => router.push("/")}
          />
        )}
      </div>
    </main>
  );
}

function getDetailStep(step: string | null): DetailStep {
  if (step === "round-list" || step === "2") return "round-list";
  return "match-details";
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
  step,
  onStepChange,
  onBackToMatches,
}: {
  detail: JobDetail;
  matchPercent: number | undefined;
  skillsPct: number | undefined;
  projectsPct: number | undefined;
  analysis: JobFitAnalysis | undefined;
  analysisLoading: boolean;
  analysisError: string | null;
  profile: OnboardingProfile | null;
  step: DetailStep;
  onStepChange: (step: DetailStep) => void;
  onBackToMatches: () => void;
}) {
  const { job } = detail;
  const experience = formatExperience(
    job.experienceMinYears,
    job.experienceMaxYears,
  );
  const meta = [job.seniority, experience, job.location, job.workMode].filter(
    Boolean,
  );
  const source = sourcePostingMeta(job.sourceUrl);
  const skills = (job.requiredSkills ?? "")
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (step === "round-list") {
    return (
      <div className="space-y-9">
        <Button
          variant="ghost"
          size="auto"
          onClick={() => onStepChange("match-details")}
          className="gap-3 border-transparent text-md font-bold text-black hover:text-black"
        >
          <ArrowLeft size={18} strokeWidth={2} /> Back
        </Button>

        <div>
          <Card className="rounded-2xl border-0 bg-white">
            <CardContent className="p-5 sm:p-6">
              <div className="min-w-0">
                <p className="text-md font-semibold text-slate-500">
                  {job.companyName}
                </p>
                <h1 className="mt-2 text-lg font-extrabold leading-[1.05] tracking-tight text-black">
                  {job.jobTitle}
                </h1>
                {meta.length > 0 && (
                  <p className="mt-3 text-sm text-slate-500">
                    <span className="capitalize">{meta.join(" · ")}</span>
                  </p>
                )}
                {job.sourceUrl && (
                  <a
                    href={job.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-6 inline-flex items-center gap-2 rounded-xl bg-violet-50 px-4 py-2 text-sm font-bold text-violet-600 hover:text-violet-800"
                  >
                    <span
                      className={
                        "flex h-5 w-5 items-center justify-center rounded text-sm font-black text-white " +
                        source.iconClass
                      }
                    >
                      {source.icon}
                    </span>
                    View original posting
                  </a>
                )}
                {job.roleSummary && (
                  <p className="mt-5 max-w-5xl text-base leading-7 text-slate-500">
                    {job.roleSummary}
                  </p>
                )}
                <div className="mt-6 flex flex-wrap items-center gap-4">
                  {skillsPct != null && (
                    <Badge className="rounded-xl border-0 bg-slate-100 px-3 py-2 text-base text-black">
                      <strong>{skillsPct}%</strong> Skills
                    </Badge>
                  )}
                  {projectsPct != null && (
                    <Badge className="rounded-xl border-0 bg-slate-100 px-3 py-2 text-base text-black">
                      <strong>{projectsPct}%</strong> Projects
                    </Badge>
                  )}
                  <Badge className="rounded-xl border-0 bg-slate-100 px-3 py-2 text-base text-black">
                    {job.rounds.length} Rounds
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Rounds rounds={job.rounds} job={job} profile={profile} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="auto"
        onClick={onBackToMatches}
        className="gap-3 border-transparent text-md font-bold text-black hover:text-black"
      >
        <ArrowLeft size={18} strokeWidth={2} /> Back
      </Button>

      <Card className="rounded-2xl border-0 bg-white">
        <CardContent className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <p className="text-md font-semibold text-slate-500">
                {job.companyName}
              </p>
              <h1 className="mt-2 text-lg font-extrabold leading-[1.05] tracking-tight text-black">
                {job.jobTitle}
              </h1>
              {meta.length > 0 && (
                <p className="mt-3 text-sm text-slate-500">
                  <span className="capitalize">{meta.join(" · ")}</span>
                </p>
              )}
              {job.sourceUrl && (
                <a
                  href={job.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-6 inline-flex items-center gap-2 rounded-xl bg-violet-50 px-4 py-2 text-sm font-bold text-violet-600 hover:text-violet-800"
                >
                  <span
                    className={
                      "flex h-5 w-5 items-center justify-center rounded text-sm font-black text-white " +
                      source.iconClass
                    }
                  >
                    {source.icon}
                  </span>
                  View original posting
                </a>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-7">
              <MatchScoreRing score={matchPercent} />
              <Button
                variant="accent"
                size="lg"
                onClick={() => onStepChange("round-list")}
                className="rounded-full border-transparent bg-[linear-gradient(90deg,#5B37C8_0%,#6D47F4_100%)] px-10 text-md font-bold text-white shadow-sm hover:opacity-95"
              >
                Start Interview
              </Button>
            </div>
          </div>

          {job.roleSummary && (
            <p className="mt-5 max-w-5xl text-base leading-7 text-slate-500">
              {job.roleSummary}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-4">
            {skillsPct != null && (
              <Badge className="rounded-xl border-0 bg-slate-100 px-3 py-2 text-base text-black">
                <strong>{skillsPct}%</strong> Skills
              </Badge>
            )}
            {projectsPct != null && (
              <Badge className="rounded-xl border-0 bg-slate-100 px-3 py-2 text-base text-black">
                <strong>{projectsPct}%</strong> Projects
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {profile ? (
        <JobFitSections
          analysis={analysis}
          loading={analysisLoading}
          error={analysisError}
          fallbackSkills={skills}
        />
      ) : (
        skills.length > 0 && (
          <SkillsCard
            skills={skills.map((skill) => ({ skill, matched: false }))}
          />
        )
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

function MatchScoreRing({ score }: { score: number | undefined }) {
  return (
    <div className="flex size-12 items-center justify-center rounded-full border-[2px] border-emerald-500 text-md font-extrabold text-black">
      {score == null ? "—" : `${score}%`}
    </div>
  );
}

function SkillsCard({
  skills,
}: {
  skills: { skill: string; matched: boolean }[];
}) {
  const sortedSkills = [
    ...skills.filter((skill) => skill.matched),
    ...skills.filter((skill) => !skill.matched),
  ];

  return (
    <Card className="rounded-2xl border-0 bg-white">
      <CardContent className="p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-md font-extrabold uppercase tracking-tight text-slate-500">
            Skills
          </h2>
          <Button
            variant="ghost"
            size="auto"
            className="border-transparent text-md font-bold text-slate-500 hover:text-slate-700"
          >
            + Add Skills
          </Button>
        </div>
        <div className="flex flex-wrap gap-3">
          {sortedSkills.map((s, i) => (
            <Badge
              key={i}
              className={
                "inline-flex items-center gap-2 rounded-xl border-0 px-3 py-2 text-base font-semibold " +
                (s.matched
                  ? "bg-amber-50 text-orange-600"
                  : "bg-slate-100 text-black")
              }
            >
              {s.matched && (
                <span className="flex size-5 items-center justify-center rounded bg-[#11bf2a] text-md text-white">
                  ✓
                </span>
              )}
              {s.skill}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
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
      {skills.length > 0 && <SkillsCard skills={sortedSkills} />}

      {loading && (
        <Card className="rounded-2xl border-0 bg-white">
          <CardContent className="p-5 sm:p-6">
            <p className="flex items-center gap-2 text-base font-semibold text-slate-500">
              <Loader2 size={15} className="animate-spin" /> Analyzing your
              resume against this role…
            </p>
          </CardContent>
        </Card>
      )}

      {error && !loading && (
        <Card className="rounded-2xl border-0 bg-white">
          <CardContent className="p-5 sm:p-6">
            <p className="text-base text-rose-600">{error}</p>
          </CardContent>
        </Card>
      )}

      {analysis && !loading && (
        <>
          <FitAccordion
            title="Responsibilities"
            section={analysis.responsibilities}
          />
          <FitAccordion title="Requirements" section={analysis.requirements} />
          <FitAccordion title="Nice to have" section={analysis.niceToHaves} />
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
  if (section.items.length === 0) return null;

  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={defaultOpen ? "content" : undefined}
      className="rounded-2xl bg-white"
    >
      <AccordionItem value="content" className="border-b-0">
        <AccordionTrigger className="px-5 py-5 text-left hover:no-underline sm:px-6 [&>svg]:text-slate-950">
          <h2 className="text-md font-bold uppercase tracking-tight text-slate-500">
            {title}
          </h2>
        </AccordionTrigger>
        <AccordionContent className="space-y-5 px-5 pb-5 sm:px-6">
          <FitGroup
            label="Strong Match"
            items={section.items.filter((item) => item.status === "found")}
            matched
          />
          <FitGroup
            label="Gap"
            items={section.items.filter((item) => item.status === "missing")}
          />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
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
          "mb-3 flex items-center gap-2 text-md font-bold " +
          (matched ? "text-emerald-700" : "text-rose-600")
        }
      >
        {matched ? (
          <Goal size={18} strokeWidth={2.25} />
        ) : (
          <Blocks size={18} strokeWidth={2.25} />
        )}
        <h3>{label}</h3>
      </div>
      <ul className="space-y-3">
        {items.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-3 text-base leading-[1.55] text-slate-600"
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
    <Card className="rounded-[34px] border-0 bg-[linear-gradient(180deg,#100629_0%,#32157A_100%)]">
      <CardContent className="px-5 py-8 sm:px-6">
        <ol className="relative space-y-10">
          <span
            aria-hidden
            className="absolute left-8 top-8 bottom-8 w-[3px] rounded-full bg-[#6D47F4]/45"
          />
          {rounds.map((r, i) => (
            <RoundItem
              key={r.position}
              round={r}
              index={i}
              job={job}
              profile={profile}
            />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function RoundItem({
  round,
  index,
  job,
  profile,
}: {
  round: Round;
  index: number;
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
  const roundNumber = index + 1;

  async function startInterview(nextQuestions?: GeneratedQuestion[]) {
    const activeQuestions = nextQuestions ?? questions;
    if (!activeQuestions || activeQuestions.length === 0) return;
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
        questions: activeQuestions,
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

  async function generate(): Promise<GeneratedQuestion[]> {
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
      const generatedQuestions = result.questions ?? [];
      setQuestions(generatedQuestions);
      return generatedQuestions;
    } catch (e) {
      setGenError(
        e instanceof Error ? e.message : "Failed to generate questions.",
      );
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function startRound() {
    if (loading || starting || !questions?.length) return;
    await startInterview(questions);
  }

  const hasGeneratedQuestions = Boolean(questions?.length);

  return (
    <li className="relative grid grid-cols-[72px_1fr] gap-x-5">
      <span className="relative z-10 flex size-11 shrink-0 items-center justify-center rounded-full bg-[#6D47F4] text-base font-bold text-white">
        {roundNumber === 1 ? roundNumber : <Phone size={20} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-base font-extrabold uppercase tracking-[0.16em] text-[#31E747]">
            Round {roundNumber}
          </p>
          <Badge className="rounded-full border border-white/20 bg-white/10 px-5 py-2 text-base font-bold text-white">
            {mins} min
          </Badge>
        </div>

        <Card className="rounded-2xl border border-white/80 bg-white p-5 text-black">
          <CardContent className="p-0">
            <div className="flex items-start justify-between gap-5">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold">{round.title}</h3>
                <p className="mt-3 max-w-4xl text-base text-slate-500">
                  {getRoundDescription(round)}
                </p>
              </div>
            </div>

            {genError && (
              <p className="mt-4 text-base text-rose-600">{genError}</p>
            )}

            <div className="mt-8 space-y-6">
              {round.competencies.length > 0 && (
                <div>
                  <p className="text-base font-bold text-slate-500">
                    Questions may cover
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {round.competencies.map((c, ci) => (
                      <Badge
                        key={ci}
                        className="rounded-xl border-0 bg-slate-100 px-3 py-2 text-base text-black"
                      >
                        {c}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {hasGeneratedQuestions && questions ? (
                <Accordion
                  type="single"
                  collapsible
                  defaultValue="generated-questions"
                  className="rounded-2xl border border-slate-200 bg-slate-50"
                >
                  <AccordionItem
                    value="generated-questions"
                    className="border-b-0"
                  >
                    <AccordionTrigger className="px-4 py-3 text-left text-md font-bold text-slate-900 hover:no-underline">
                      Generated questions
                    </AccordionTrigger>
                    <AccordionContent className="px-4 pb-4">
                      <ol className="space-y-3">
                        {questions.map((question, questionIndex) => (
                          <li
                            key={question.id}
                            className="flex gap-3 text-base leading-7 text-slate-600"
                          >
                            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-slate-500">
                              {questionIndex + 1}
                            </span>
                            <span>{question.text}</span>
                          </li>
                        ))}
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : null}

              <div className="flex justify-end">
                <Button
                  variant="accent"
                  size="lg"
                  onClick={hasGeneratedQuestions ? startRound : generate}
                  disabled={starting || loading}
                  className="w-full gap-3 rounded-full border-transparent bg-[linear-gradient(90deg,#5B37C8_0%,#6D47F4_100%)] px-6 text-md font-bold text-white hover:opacity-95 lg:w-56"
                >
                  {starting || loading ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : hasGeneratedQuestions ? (
                    <Play size={18} fill="currentColor" />
                  ) : (
                    <Sparkles size={18} />
                  )}
                  {starting
                    ? "Starting…"
                    : loading
                      ? "Generating…"
                      : hasGeneratedQuestions
                        ? `Start Round ${roundNumber}`
                        : "Generate questions"}
                </Button>
              </div>
            </div>

            {startError && (
              <p className="mt-4 text-base text-rose-600">{startError}</p>
            )}
          </CardContent>
        </Card>
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

function getRoundDescription(round: Round) {
  if (round.competencies.length > 0) {
    return `Evaluates ${round.competencies
      .slice(0, 3)
      .join(", ")
      .toLowerCase()} for this role.`;
  }

  return "This round evaluates your role readiness through focused interview questions.";
}
