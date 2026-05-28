"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";

type Company = { id: string; name: string };
type Skill = { name: string };

type Round = { position: number; slug: string; title: string };

type JobCard = {
  jobId: string;
  jobTitle: string;
  companyName: string;
  seniority: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  roundCount: number;
  rounds: Round[];
  score: number;
};

function formatExperience(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null) return `${min}–${max} yrs`;
  if (min !== null) return `${min}+ yrs`;
  return `up to ${max} yrs`;
}

export default function HomePage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [companyText, setCompanyText] = useState("");
  const [roleText, setRoleText] = useState("");
  const [experienceYears, setExperienceYears] = useState("");
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [cards, setCards] = useState<JobCard[] | null>(null);
  const [openJobIds, setOpenJobIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/options")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load options");
        return response.json();
      })
      .then((data) => {
        setCompanies(data.companies);
        setSkills(data.skills);
      })
      .catch(() => setError("Connect the database and import jobs to load options."));
  }, []);

  const companyOptions = useMemo(() => companies.map((company) => company.name), [companies]);

  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    if (query === "") return [];
    return skills
      .filter((skill) => !skillNames.includes(skill.name) && skill.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [skills, skillNames, skillSearch]);

  function toggleSkill(name: string) {
    setSkillNames((current) => {
      if (current.includes(name)) return current.filter((item) => item !== name);
      setSkillSearch("");
      return [...current, name];
    });
  }

  // Add a free-typed skill (may not exist in the suggestion list). Deduped case-insensitively.
  function addSkill(raw: string) {
    const name = raw.trim();
    if (!name) return;
    setSkillNames((current) =>
      current.some((s) => s.toLowerCase() === name.toLowerCase()) ? current : [...current, name]
    );
    setSkillSearch("");
  }

  const trimmedSkill = skillSearch.trim();
  const canAddCustomSkill =
    trimmedSkill !== "" &&
    !skillNames.some((s) => s.toLowerCase() === trimmedSkill.toLowerCase()) &&
    !filteredSkills.some((s) => s.name.toLowerCase() === trimmedSkill.toLowerCase());

  async function runSearch(input: {
    companyText: string;
    roleText: string;
    skillNames: string[];
    experienceYears: number | null;
  }) {
    setLoading(true);
    setError("");
    setOpenJobIds(new Set());
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await response.json();
      setCards(data.cards ?? []);
    } catch {
      setError("Could not run search. Check the database connection.");
    } finally {
      setLoading(false);
    }
  }

  function search() {
    runSearch({
      companyText,
      roleText,
      skillNames,
      experienceYears: experienceYears === "" ? null : Number(experienceYears),
    });
  }

  // Arriving from /onboarding: prefill the form from the derived search input and run it once.
  useEffect(() => {
    const raw = sessionStorage.getItem("rounds:autosearch");
    if (!raw) return;
    sessionStorage.removeItem("rounds:autosearch");
    try {
      const input = JSON.parse(raw);
      setCompanyText(input.companyText ?? "");
      setRoleText(input.roleText ?? "");
      setSkillNames(Array.isArray(input.skillNames) ? input.skillNames : []);
      setExperienceYears(input.experienceYears == null ? "" : String(input.experienceYears));
      runSearch({
        companyText: input.companyText ?? "",
        roleText: input.roleText ?? "",
        skillNames: Array.isArray(input.skillNames) ? input.skillNames : [],
        experienceYears: input.experienceYears ?? null,
      });
    } catch {
      // ignore malformed payload
    }
  }, []);

  function toggleCard(jobId: string) {
    setOpenJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  return (
    <main className="shell">
      <Card className="form-card">
        <CardContent>
          <div className="grid">
            <label>
              Company
              <Input
                list="company-options"
                value={companyText}
                onChange={(event) => setCompanyText(event.target.value)}
                placeholder="e.g. Google, Accenture, Trimble"
              />
              <datalist id="company-options">
                {companyOptions.map((company) => (
                  <option key={company} value={company} />
                ))}
              </datalist>
            </label>

            <label>
              Role / job title
              <Input
                value={roleText}
                onChange={(event) => setRoleText(event.target.value)}
                placeholder="e.g. Software Engineer, Data Engineer, ML"
              />
            </label>

            <label>
              Years of experience (optional)
              <Input
                min="0"
                max="60"
                type="number"
                value={experienceYears}
                onChange={(event) => setExperienceYears(event.target.value)}
                placeholder="e.g. 4"
              />
            </label>

            <label className="wide">
              Key skills (optional)
              <Input
                value={skillSearch}
                onChange={(event) => setSkillSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addSkill(skillSearch);
                  }
                }}
                placeholder="Search or type a skill, press Enter to add"
              />
              {skillNames.length > 0 && (
                <div className="skill-bank">
                  {skillNames.map((name) => (
                    <Button
                      key={name}
                      className="skill selected"
                      variant="outline"
                      onClick={() => toggleSkill(name)}
                    >
                      {name} ×
                    </Button>
                  ))}
                </div>
              )}
              {(filteredSkills.length > 0 || canAddCustomSkill) && (
                <div className="skill-bank">
                  {filteredSkills.map((skill) => (
                    <Button
                      key={skill.name}
                      className="skill"
                      variant="outline"
                      onClick={() => toggleSkill(skill.name)}
                    >
                      {skill.name}
                    </Button>
                  ))}
                  {canAddCustomSkill && (
                    <Button
                      className="skill"
                      variant="outline"
                      onClick={() => addSkill(skillSearch)}
                    >
                      + Add &ldquo;{trimmedSkill}&rdquo;
                    </Button>
                  )}
                </div>
              )}
            </label>
          </div>

          <Button className="search-button" variant="outline" onClick={search} disabled={loading}>
            <Search size={28} />
            {loading ? "Searching..." : "Find interview rounds"}
          </Button>

          {error && <p className="status">{error}</p>}
        </CardContent>
      </Card>

      <Card className="result-card">
        <CardContent>
          {loading && (
            <div className="search-loader">
              <Loader2 size={22} className="spin" />
              <span>Searching jobs…</span>
            </div>
          )}
          {!loading && cards === null && <p className="muted">Results will appear here as cards.</p>}
          {!loading && cards && cards.length === 0 && <p>No matches found. Try broader inputs.</p>}
          {!loading && cards && cards.length > 0 && (
            <div className="card-grid">
              {cards.map((card) => {
                const isOpen = openJobIds.has(card.jobId);
                const experience = formatExperience(card.experienceMinYears, card.experienceMaxYears);
                return (
                  <div key={card.jobId} className={isOpen ? "plan-card is-open" : "plan-card"}>
                    <button className="plan-card-header" onClick={() => toggleCard(card.jobId)}>
                      <div className="plan-card-titles">
                        <p className="plan-card-company">{card.jobTitle}</p>
                        <p className="plan-card-role">
                          {card.companyName} · <span className="muted">{card.seniority}</span>
                          {experience ? <span className="muted"> · {experience}</span> : null}
                        </p>
                      </div>
                      <Badge className="round-badge">{card.roundCount} rounds</Badge>
                    </button>
                    {isOpen && (
                      <div className="plan-card-detail">
                        <ol className="rounds">
                          {card.rounds.map((round) => (
                            <li key={round.position}>
                              <strong>{round.title}</strong>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
