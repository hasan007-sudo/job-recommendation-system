"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { Badge } from "../components/shadcn/badge";
import { Button } from "../components/shadcn/button";
import { Card, CardContent } from "../components/shadcn/card";
import { Input } from "../components/shadcn/input";
import { Textarea } from "../components/shadcn/textarea";
import {
  type JobCard,
  type SearchInput,
  type SortMode,
  useJobOptions,
  useJobSearch,
} from "../hooks/use-job-search";
import { buildProjectTexts, type OnboardingProfile } from "../lib/onboarding";
import { formatExperience, tierFor } from "../lib/display";

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
  // name → gloss for profile-parsed skills; manually added chips have none.
  const [skillGlosses, setSkillGlosses] = useState<Record<string, string>>({});
  const [skillSearch, setSkillSearch] = useState("");
  const [roleText, setRoleText] = useState<string>("");
  const [companyText, setCompanyText] = useState<string>("");
  const [experienceMin, setExperienceMin] = useState<string>("");
  const [experienceMax, setExperienceMax] = useState<string>("");
  const [projectTexts, setProjectTexts] = useState<string[]>([]);
  const [sort, setSort] = useState<SortMode>("default");
  // The committed search input that drives the query. Only changes on "Update
  // results", changeSort, or autosearch — not on every keystroke. Modeling
  // search as a useQuery keyed by this input gives caching (instant re-display
  // on back-navigation), request dedupe, and no stale data on filter change.
  const [searchInput, setSearchInput] = useState<SearchInput | null>(null);

  const optionsQuery = useJobOptions();
  const skills = optionsQuery.data?.skills ?? [];

  const searchQuery = useJobSearch(searchInput);

  const cards = searchQuery.data?.cards ?? null;
  const loading = searchInput != null && searchQuery.isPending;
  const error = searchQuery.isError
    ? "Could not run search. Check the database connection."
    : optionsQuery.isError
      ? "Connect the database and import jobs to load options."
      : "";

  // Commit a search: update the query key (triggers the fetch) and persist the
  // full input so a remount rebuilds an identical key → cache hit.
  function runSearch(input: SearchInput) {
    setSearchInput(input);
    sessionStorage.setItem("rounds:search", JSON.stringify(input));
  }

  useEffect(() => {
    const raw = sessionStorage.getItem("rounds:profile");
    let profileSkills: string[] | null = null;
    if (raw) {
      try {
        const p: OnboardingProfile = JSON.parse(raw);
        setProfile(p);
        profileSkills = p.skills ?? null;
        if (p.skillGlosses) setSkillGlosses(p.skillGlosses);
        if (p.roleHint) setRoleText(p.roleHint);
        if (p.experienceMinYears != null)
          setExperienceMin(String(p.experienceMinYears));
        if (p.experienceMaxYears != null)
          setExperienceMax(String(p.experienceMaxYears));
        // Same project-text shape as deriveSearchInput: prefers the LLM-extracted
        // capability statements, falls back to description+keywords.
        const pt = buildProjectTexts(p);
        if (pt.length > 0) setProjectTexts(pt);
      } catch {
        // ignore
      }
    }

    const auto = sessionStorage.getItem("rounds:autosearch");
    if (auto) {
      sessionStorage.removeItem("rounds:autosearch");
      try {
        const input = JSON.parse(auto);
        // New payloads carry glossed skills; older cached ones carry skillNames.
        const autoSkills: { name: string; gloss?: string }[] = Array.isArray(
          input.skills,
        )
          ? input.skills
          : Array.isArray(input.skillNames)
            ? input.skillNames.map((name: string) => ({ name }))
            : [];
        const autoProjectTexts: string[] = Array.isArray(input.projectTexts)
          ? input.projectTexts
          : typeof input.projectText === "string" && input.projectText
            ? [input.projectText]
            : [];
        const autoSort: SortMode = input.sort === "score" ? "score" : "default";
        setSkillNames(autoSkills.map((s) => s.name));
        setSkillGlosses((cur) => ({
          ...cur,
          ...Object.fromEntries(
            autoSkills.filter((s) => s.gloss).map((s) => [s.name, s.gloss!]),
          ),
        }));
        setProjectTexts(autoProjectTexts);
        setSort(autoSort);
        const autoMin = input.experienceMinYears ?? null;
        const autoMax = input.experienceMaxYears ?? null;
        setExperienceMin(autoMin == null ? "" : String(autoMin));
        setExperienceMax(autoMax == null ? "" : String(autoMax));
        runSearch({
          companyText: "",
          roleText: input.roleText ?? "",
          skills: autoSkills,
          experienceMinYears: autoMin,
          experienceMaxYears: autoMax,
          projectTexts: autoProjectTexts,
          sort: autoSort,
        });
        return;
      } catch {
        // fall through
      }
    }

    // Back-navigation / reload: rebuild the full committed input so the query
    // key matches the cached entry and results re-display instantly.
    const cachedSearch = sessionStorage.getItem("rounds:search");
    if (cachedSearch) {
      try {
        const input: SearchInput = JSON.parse(cachedSearch);
        setRoleText(input.roleText ?? "");
        setCompanyText(input.companyText ?? "");
        setSkillNames((input.skills ?? []).map((s) => s.name));
        setSkillGlosses((cur) => ({
          ...cur,
          ...Object.fromEntries(
            (input.skills ?? [])
              .filter((s) => s.gloss)
              .map((s) => [s.name, s.gloss!]),
          ),
        }));
        setExperienceMin(
          input.experienceMinYears == null
            ? ""
            : String(input.experienceMinYears),
        );
        setExperienceMax(
          input.experienceMaxYears == null
            ? ""
            : String(input.experienceMaxYears),
        );
        setProjectTexts(input.projectTexts ?? []);
        setSort(input.sort === "score" ? "score" : "default");
        setSearchInput(input);
        return;
      } catch {
        // fall through
      }
    }

    if (profileSkills?.length) {
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

  // Chips → glossed skills: profile-parsed skills carry their gloss, manual
  // chips match by exact token only.
  function buildSkills(): { name: string; gloss?: string }[] {
    return skillNames.map((name) => ({ name, gloss: skillGlosses[name] }));
  }

  function updateResults() {
    runSearch({
      companyText,
      roleText,
      skills: buildSkills(),
      experienceMinYears: experienceMin === "" ? null : Number(experienceMin),
      experienceMaxYears: experienceMax === "" ? null : Number(experienceMax),
      projectTexts,
      sort,
    });
  }

  // Re-run the search under a new sort mode (sorting happens server-side).
  function changeSort(next: SortMode) {
    if (next === sort) return;
    setSort(next);
    runSearch({
      companyText,
      roleText,
      skills: buildSkills(),
      experienceMinYears: experienceMin === "" ? null : Number(experienceMin),
      experienceMaxYears: experienceMax === "" ? null : Number(experienceMax),
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
            <span className="text-md font-bold tracking-tight text-slate-900">
              Rounds
            </span>
          </div>
          <Button
            variant="ghost"
            size="auto"
            onClick={() => router.push("/onboarding")}
            className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 hover:text-slate-900"
          >
            Edit resume
          </Button>
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
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                Find your next round
              </h1>

              <Field label="Role">
                <Input
                  value={roleText}
                  onChange={(e) => setRoleText(e.target.value)}
                  placeholder="e.g. Frontend Engineer, SDE"
                  className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-indigo-500"
                />
              </Field>

              <Field label="Company">
                <Input
                  value={companyText}
                  onChange={(e) => setCompanyText(e.target.value)}
                  placeholder="e.g. Google, Amazon (comma-separated)"
                  className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-indigo-500"
                />
              </Field>

              <Field label="Years of experience">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    value={experienceMin}
                    onChange={(e) => setExperienceMin(e.target.value)}
                    placeholder="Min"
                    className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-indigo-500"
                  />
                  <span className="text-sm text-slate-400">–</span>
                  <Input
                    type="number"
                    min="0"
                    value={experienceMax}
                    onChange={(e) => setExperienceMax(e.target.value)}
                    placeholder="Max"
                    className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-indigo-500"
                  />
                </div>
              </Field>

              <Field label="Key skills">
                <div className="flex flex-wrap gap-1.5">
                  {skillNames.map((s) => (
                    <Badge
                      key={s}
                      variant="accent"
                      className="rounded-md border-0 bg-indigo-500 px-2.5 py-1 text-xs text-white"
                    >
                      {s}
                      <Button
                        variant="ghost"
                        size="auto"
                        onClick={() =>
                          setSkillNames((cur) => cur.filter((x) => x !== s))
                        }
                        aria-label={`remove ${s}`}
                        className="border-0 text-white/80 hover:text-white"
                      >
                        <X size={12} strokeWidth={2.5} />
                      </Button>
                    </Badge>
                  ))}
                </div>
                <div className="relative mt-2">
                  <Input
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSkill(skillSearch);
                      }
                    }}
                    placeholder="Search or add a skill"
                    className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-indigo-500"
                  />
                  {filteredSkills.length > 0 && (
                    <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                      {filteredSkills.map((s) => (
                        <Button
                          key={s.name}
                          variant="ghost"
                          size="auto"
                          onClick={() => addSkill(s.name)}
                          className="block w-full rounded-none border-0 px-3 py-2 text-left text-sm hover:bg-indigo-50"
                        >
                          {s.name}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </Field>

              <Field label="Projects skills">
                <Textarea
                  value={projectTexts.join(", ")}
                  onChange={(e) =>
                    setProjectTexts(e.target.value ? [e.target.value] : [])
                  }
                  placeholder="Describe your projects — what you built and the tech used"
                  rows={4}
                  className="rounded-lg border-slate-200 bg-white text-sm leading-[1.5] focus:border-indigo-500"
                />
              </Field>

              <Button
                onClick={updateResults}
                disabled={loading}
                size="lg"
                className="w-full rounded-lg bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : null}
                {loading ? "Searching…" : "Update results"}
              </Button>

              {error && <p className="text-sm text-rose-600">{error}</p>}
            </div>
          </aside>

          <section>
            <div className="mb-5 flex items-end justify-between">
              <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-slate-500">
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
                    <Button
                      key={value}
                      variant={sort === value ? "default" : "ghost"}
                      size="auto"
                      onClick={() => changeSort(value)}
                      disabled={loading}
                      className={
                        "rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-60 " +
                        (sort === value
                          ? "bg-slate-900 text-white"
                          : "border-0 text-slate-500 hover:text-slate-900")
                      }
                    >
                      {label}
                    </Button>
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
      <Card className="rounded-2xl border-dashed border-slate-300 bg-white">
        <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
            Active resume
          </span>
          <Button
            variant="link"
            size="auto"
            onClick={onEdit}
            className="text-xs font-semibold text-indigo-600"
          >
            Upload
          </Button>
        </div>
        <p className="mt-3 text-sm text-slate-500">
          Upload your resume to see match percentages.
        </p>
        </CardContent>
      </Card>
    );
  }

  const edu = profile.education;
  const eduLine = [edu?.degree, edu?.major, edu?.institution]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="rounded-2xl border-slate-200 bg-white">
      <CardContent className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
          Active resume
        </span>
        <Button
          variant="link"
          size="auto"
          onClick={onEdit}
          className="text-xs font-semibold text-indigo-600"
        >
          Edit
        </Button>
      </div>
      <p className="text-base font-bold text-slate-900">
        {profile.name || "Your resume"}
      </p>
      {eduLine && <p className="mt-1 text-sm text-slate-500">{eduLine}</p>}
      {/* {profile.skills && profile.skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profile.skills.map((s) => (
            <span
              key={s}
              className="inline-flex items-center rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-800"
            >
              {s}
            </span>
          ))}
        </div>
      )} */}
      </CardContent>
    </Card>
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
      <div className="mb-1.5 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card className="rounded-2xl border-dashed border-slate-300 bg-white text-center">
      <CardContent className="px-6 py-10">
      <p className="text-md font-bold text-slate-900">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
      </CardContent>
    </Card>
  );
}

function JobRow({ card, onClick }: { card: JobCard; onClick: () => void }) {
  const tier = tierFor(card.score ?? undefined);
  const experience = formatExperience(
    card.experienceMinYears,
    card.experienceMaxYears,
  );
  return (
    <Button
      variant="ghost"
      size="auto"
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:shadow-sm"
    >
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-md font-bold text-white">
        {initials(card.companyName)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-bold text-slate-900">
          {card.jobTitle}
        </p>
        <p className="mt-0.5 truncate text-sm text-slate-500">
          {card.companyName} ·{" "}
          <span className="capitalize">{card.seniority}</span>
          {experience ? ` · ${experience}` : ""}
        </p>
        {card.matchedSkills != null && (
          <p className="mt-1.5 text-xs font-semibold text-slate-400">
            {card.matchedSkills} / {card.totalSkills} skills matched
          </p>
        )}
      </div>
      <div className="hidden text-center sm:block">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
          Rounds
        </p>
        <p className="text-lg font-bold text-slate-900">
          {card.roundCount}
        </p>
      </div>
      <div className="relative min-w-[96px] text-right">
        {tier ? (
          <>
            <p className={`text-xl font-bold leading-none ${tier.color}`}>
              {card.score}%
            </p>
            <p
              className={`mt-1 text-xs font-bold uppercase tracking-[0.16em] ${tier.color}`}
            >
              {tier.label}
            </p>
          </>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
        {card.score != null && (
          <div className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-44 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-md group-hover:block">
            <p className="mb-2.5 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
              Match breakdown
            </p>
            <BreakdownRow label="Required skills" value={card.skillsPct} />
            <BreakdownRow label="Project evidence" value={card.projectsPct} />
          </div>
        )}
      </div>
    </Button>
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
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-xs font-semibold text-slate-900">
        {value == null ? "—" : `${value}%`}
      </span>
    </div>
  );
}
