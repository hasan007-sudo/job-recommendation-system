"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import type { OnboardingProfile } from "../lib/onboarding";
import type { ParsedRound } from "../lib/rounds";
import { formatExperience, tierFor } from "../lib/display";
import { getJson, postJson } from "../lib/api";

type Skill = { name: string };

type JobCard = {
  jobId: string;
  jobTitle: string;
  companyName: string;
  seniority: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  roundCount: number;
  rounds: ParsedRound[];
  score: number | null;
  skillsPct: number | null;
  projectsPct: number | null;
  roleOrCompanyMatched: boolean;
  matchedSkills: number | null;
  totalSkills: number;
};

type SortMode = "default" | "score";

type SearchInput = {
  companyText: string;
  roleText: string;
  skillNames: string[];
  experienceYears: number | null;
  projectTexts: string[];
  sort: SortMode;
};

const EXP_OPTIONS: { label: string; value: string }[] = [
  { label: "Any", value: "" },
  { label: "0–2 yrs", value: "1" },
  { label: "3–5 yrs", value: "4" },
  { label: "6–8 yrs", value: "7" },
  { label: "8+ yrs", value: "9" },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0] + parts[1]![0]).toUpperCase();
}

export default function HomePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [roleText, setRoleText] = useState<string>("");
  const [companyText, setCompanyText] = useState<string>("");
  const [experienceYears, setExperienceYears] = useState<string>("");
  const [projectTexts, setProjectTexts] = useState<string[]>([]);
  const [sort, setSort] = useState<SortMode>("default");
  const [cards, setCards] = useState<JobCard[] | null>(null);

  const optionsQuery = useQuery({
    queryKey: ["options"],
    queryFn: () => getJson<{ skills: Skill[] }>("/api/options"),
  });
  const skills = optionsQuery.data?.skills ?? [];

  const searchMutation = useMutation({
    mutationFn: (input: SearchInput) =>
      postJson<{ cards: JobCard[] }>("/api/search", input),
    onSuccess: (data, input) => {
      const newCards: JobCard[] = data.cards ?? [];
      setCards(newCards);
      sessionStorage.setItem(
        "rounds:filters",
        JSON.stringify({
          roleText: input.roleText,
          companyText: input.companyText,
          skillNames: input.skillNames,
          experienceYears:
            input.experienceYears == null ? "" : String(input.experienceYears),
        }),
      );
    },
  });

  const loading = searchMutation.isPending;
  const error = searchMutation.isError
    ? "Could not run search. Check the database connection."
    : optionsQuery.isError
      ? "Connect the database and import jobs to load options."
      : "";

  useEffect(() => {
    const raw = sessionStorage.getItem("rounds:profile");
    let profileSkills: string[] | null = null;
    if (raw) {
      try {
        const p: OnboardingProfile = JSON.parse(raw);
        setProfile(p);
        profileSkills = p.skills ?? null;
        if (p.roleHint) setRoleText(p.roleHint);
        if (p.experienceYears != null)
          setExperienceYears(String(p.experienceYears));
        if (p.projectKeywords?.length)
          setProjectTexts(
            p.projectKeywords.map((kws) => kws.join(", ")).filter(Boolean),
          );
        else if (p.projects?.length) setProjectTexts([p.projects.join(". ")]);
      } catch {
        // ignore
      }
    }

    const auto = sessionStorage.getItem("rounds:autosearch");
    if (auto) {
      sessionStorage.removeItem("rounds:autosearch");
      try {
        const input = JSON.parse(auto);
        const skills = Array.isArray(input.skillNames) ? input.skillNames : [];
        const autoProjectTexts: string[] = Array.isArray(input.projectTexts)
          ? input.projectTexts
          : typeof input.projectText === "string" && input.projectText
            ? [input.projectText]
            : [];
        const autoSort: SortMode = input.sort === "score" ? "score" : "default";
        setSkillNames(skills);
        setProjectTexts(autoProjectTexts);
        setSort(autoSort);
        searchMutation.mutate({
          companyText: "",
          roleText: input.roleText ?? "",
          skillNames: skills,
          experienceYears: input.experienceYears ?? null,
          projectTexts: autoProjectTexts,
          sort: autoSort,
        });
        return;
      } catch {
        // fall through
      }
    }

    const cachedFilters = sessionStorage.getItem("rounds:filters");
    if (cachedFilters) {
      try {
        const f = JSON.parse(cachedFilters);
        if (typeof f.roleText === "string") setRoleText(f.roleText);
        if (typeof f.companyText === "string") setCompanyText(f.companyText);
        if (Array.isArray(f.skillNames)) setSkillNames(f.skillNames);
        if (typeof f.experienceYears === "string")
          setExperienceYears(f.experienceYears);
      } catch {
        // ignore
      }
    } else if (profileSkills?.length) {
      setSkillNames(profileSkills);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredSkills = useMemo(() => {
    const q = skillSearch.trim().toLowerCase();
    if (!q) return [];
    return skills
      .filter(
        (s) => !skillNames.includes(s.name) && s.name.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [skills, skillNames, skillSearch]);

  function addSkill(raw: string) {
    const name = raw.trim();
    if (!name) return;
    setSkillNames((cur) =>
      cur.some((s) => s.toLowerCase() === name.toLowerCase())
        ? cur
        : [...cur, name],
    );
    setSkillSearch("");
  }

  function updateResults() {
    searchMutation.mutate({
      companyText,
      roleText,
      skillNames,
      experienceYears: experienceYears === "" ? null : Number(experienceYears),
      projectTexts,
      sort,
    });
  }

  // Re-run the search under a new sort mode (sorting happens server-side).
  function changeSort(next: SortMode) {
    if (next === sort) return;
    setSort(next);
    searchMutation.mutate({
      companyText,
      roleText,
      skillNames,
      experienceYears: experienceYears === "" ? null : Number(experienceYears),
      projectTexts,
      sort: next,
    });
  }

  const matchCount = cards?.length ?? 0;

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-slate-900" />
            <span className="text-[15px] font-bold tracking-tight text-slate-900">
              Rounds
            </span>
          </div>
          <button
            onClick={() => router.push("/onboarding")}
            className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 hover:text-slate-900"
          >
            Edit resume
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[360px_1fr]">
          <aside className="space-y-6">
            <ActiveResumeCard
              profile={profile}
              onEdit={() => router.push("/onboarding")}
            />

            <div className="space-y-5">
              <h1 className="text-[22px] font-bold tracking-tight text-slate-900">
                Find your next round
              </h1>

              <Field label="Role">
                <input
                  value={roleText}
                  onChange={(e) => setRoleText(e.target.value)}
                  placeholder="e.g. Frontend Engineer, SDE"
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-[14px] outline-none placeholder:text-slate-400 focus:border-indigo-500"
                />
              </Field>

              <Field label="Company">
                <input
                  value={companyText}
                  onChange={(e) => setCompanyText(e.target.value)}
                  placeholder="e.g. Google, Razorpay"
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-[14px] outline-none placeholder:text-slate-400 focus:border-indigo-500"
                />
              </Field>

              <Field label="Years of experience">
                <div className="relative">
                  <select
                    value={experienceYears}
                    onChange={(e) => setExperienceYears(e.target.value)}
                    className="h-11 w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 pr-9 text-[14px] text-slate-900 outline-none focus:border-indigo-500"
                  >
                    {EXP_OPTIONS.map((o) => (
                      <option key={o.label} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <svg
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" />
                  </svg>
                </div>
              </Field>

              <Field label="Key skills">
                <div className="flex flex-wrap gap-1.5">
                  {skillNames.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white"
                    >
                      {s}
                      <button
                        onClick={() =>
                          setSkillNames((cur) => cur.filter((x) => x !== s))
                        }
                        aria-label={`remove ${s}`}
                        className="text-white/80 hover:text-white"
                      >
                        <X size={12} strokeWidth={2.5} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="relative mt-2">
                  <input
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSkill(skillSearch);
                      }
                    }}
                    placeholder="Search or add a skill"
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-[14px] outline-none placeholder:text-slate-400 focus:border-indigo-500"
                  />
                  {filteredSkills.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                      {filteredSkills.map((s) => (
                        <button
                          key={s.name}
                          onClick={() => addSkill(s.name)}
                          className="block w-full px-3 py-2 text-left text-[13px] hover:bg-indigo-50"
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Field>

              <Field label="Projects skills">
                <textarea
                  value={projectTexts.join(", ")}
                  onChange={(e) =>
                    setProjectTexts(e.target.value ? [e.target.value] : [])
                  }
                  placeholder="Describe your projects — what you built and the tech used"
                  rows={4}
                  className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] leading-[1.5] outline-none placeholder:text-slate-400 focus:border-indigo-500"
                />
              </Field>

              <button
                onClick={updateResults}
                disabled={loading}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 text-[14px] font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : null}
                {loading ? "Searching…" : "Update results"}
              </button>

              {error && <p className="text-[13px] text-rose-600">{error}</p>}
            </div>
          </aside>

          <section>
            <div className="mb-5 flex items-end justify-between">
              <h2 className="text-[13px] font-bold uppercase tracking-[0.18em] text-slate-500">
                {loading
                  ? "Searching jobs…"
                  : cards === null
                    ? "Run a search"
                    : `${matchCount} MATCHING ROLES`}
              </h2>
              {cards && cards.length > 0 && (
                <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-0.5">
                  {(
                    [
                      ["default", "Filter match (Company/Role preference)"],
                      ["score", "Match score (With skills)"],
                    ] as [SortMode, string][]
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => changeSort(value)}
                      disabled={loading}
                      className={
                        "rounded-md px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-60 " +
                        (sort === value
                          ? "bg-slate-900 text-white"
                          : "text-slate-500 hover:text-slate-900")
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {loading && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-8 text-slate-500">
                <Loader2 size={18} className="animate-spin" /> Searching jobs…
              </div>
            )}

            {!loading && cards === null && (
              <EmptyState
                title="Your matches will appear here"
                body="Pick your experience level and skills, then update results."
              />
            )}

            {!loading && cards && cards.length === 0 && (
              <EmptyState
                title="No matches found"
                body="Try broader filters."
              />
            )}

            {!loading && cards && cards.length > 0 && (
              <div className="space-y-3">
                {cards.map((card) => (
                  <JobRow
                    key={card.jobId}
                    card={card}
                    onClick={() => router.push(`/jobs/${card.jobId}`)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function ActiveResumeCard({
  profile,
  onEdit,
}: {
  profile: OnboardingProfile | null;
  onEdit: () => void;
}) {
  if (!profile) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
            Active resume
          </span>
          <button
            onClick={onEdit}
            className="text-[12px] font-semibold text-indigo-600"
          >
            Upload
          </button>
        </div>
        <p className="mt-3 text-[13px] text-slate-500">
          Upload your resume to see match percentages.
        </p>
      </div>
    );
  }

  const edu = profile.education;
  const eduLine = [edu?.degree, edu?.major, edu?.institution]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
          Active resume
        </span>
        <button
          onClick={onEdit}
          className="text-[12px] font-semibold text-indigo-600"
        >
          Edit
        </button>
      </div>
      <p className="text-[16px] font-bold text-slate-900">
        {profile.name || "Your resume"}
      </p>
      {eduLine && <p className="mt-1 text-[13px] text-slate-500">{eduLine}</p>}
      {/* {profile.skills && profile.skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profile.skills.map((s) => (
            <span
              key={s}
              className="inline-flex items-center rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-800"
            >
              {s}
            </span>
          ))}
        </div>
      )} */}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-[15px] font-bold text-slate-900">{title}</p>
      <p className="mt-1 text-[13px] text-slate-500">{body}</p>
    </div>
  );
}

function JobRow({ card, onClick }: { card: JobCard; onClick: () => void }) {
  const tier = tierFor(card.score ?? undefined);
  const experience = formatExperience(
    card.experienceMinYears,
    card.experienceMaxYears,
  );
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:shadow-sm"
    >
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-[15px] font-bold text-white">
        {initials(card.companyName)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16px] font-bold text-slate-900">
          {card.jobTitle}
        </p>
        <p className="mt-0.5 truncate text-[13px] text-slate-500">
          {card.companyName} ·{" "}
          <span className="capitalize">{card.seniority}</span>
          {experience ? ` · ${experience}` : ""}
        </p>
        {card.matchedSkills != null && (
          <p className="mt-1.5 text-[12px] font-semibold text-slate-400">
            {card.matchedSkills} / {card.totalSkills} skills matched
          </p>
        )}
      </div>
      <div className="hidden text-center sm:block">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
          Rounds
        </p>
        <p className="text-[18px] font-bold text-slate-900">
          {card.roundCount}
        </p>
      </div>
      <div className="relative min-w-[96px] text-right">
        {tier ? (
          <>
            <p className={`text-[22px] font-bold leading-none ${tier.color}`}>
              {card.score}%
            </p>
            <p
              className={`mt-1 text-[10px] font-bold uppercase tracking-[0.16em] ${tier.color}`}
            >
              {tier.label}
            </p>
          </>
        ) : (
          <span className="text-[12px] text-slate-400">—</span>
        )}
        {card.score != null && (
          <div className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-44 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-md group-hover:block">
            <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
              Match breakdown
            </p>
            <BreakdownRow label="Skills" value={card.skillsPct} />
            <BreakdownRow label="Projects" value={card.projectsPct} />
          </div>
        )}
      </div>
    </button>
  );
}

function BreakdownRow({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[12px] text-slate-500">{label}</span>
      <span className="text-[12px] font-semibold text-slate-900">
        {value == null ? "—" : `${value}%`}
      </span>
    </div>
  );
}
