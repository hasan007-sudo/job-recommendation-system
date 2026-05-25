"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";

type Company = { id: string; name: string };
type Skill = { id: string; name: string; category: string };

type PlanCard = {
  planId: string;
  companyName: string | null;
  roleName: string;
  roleSlug: string;
  seniority: string;
  roundCount: number;
  score: number;
};

type PlanDetail = {
  planId: string;
  companyName: string | null;
  roleName: string;
  seniority: string;
  roundCount: number;
  rounds: {
    id: string;
    position: number;
    roundType: string;
    title: string;
    description: string | null;
    durationMinutes: number | null;
  }[];
};

export default function HomePage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [companyText, setCompanyText] = useState("");
  const [roleText, setRoleText] = useState("");
  const [experienceYears, setExperienceYears] = useState("");
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [cards, setCards] = useState<PlanCard[] | null>(null);
  const [openPlanIds, setOpenPlanIds] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, PlanDetail>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
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
      .catch(() => setError("Connect the database and seed data to load options."));
  }, []);

  const companyOptions = useMemo(() => companies.map((company) => company.name), [companies]);

  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    if (query === "") return [];
    return skills
      .filter(
        (skill) =>
          !skillNames.includes(skill.name) &&
          skill.name.toLowerCase().includes(query)
      )
      .slice(0, 8);
  }, [skills, skillNames, skillSearch]);

  function toggleSkill(name: string) {
    setSkillNames((current) => {
      if (current.includes(name)) return current.filter((item) => item !== name);
      setSkillSearch("");
      return [...current, name];
    });
  }

  async function search() {
    setLoading(true);
    setError("");
    setOpenPlanIds(new Set());
    setDetails(new Map());
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyText,
          roleText,
          skillNames,
          experienceYears: experienceYears === "" ? null : Number(experienceYears),
        }),
      });
      const data = await response.json();
      setCards(data.cards ?? []);
    } catch {
      setError("Could not run search. Check the database connection.");
    } finally {
      setLoading(false);
    }
  }

  async function toggleCard(planId: string) {
    // Closing
    if (openPlanIds.has(planId)) {
      setOpenPlanIds((current) => {
        const next = new Set(current);
        next.delete(planId);
        return next;
      });
      return;
    }
    // Opening — add to open set immediately so card expands
    setOpenPlanIds((current) => new Set(current).add(planId));
    // Fetch detail only if we don't have it cached already
    if (details.has(planId)) return;
    setLoadingIds((current) => new Set(current).add(planId));
    try {
      const response = await fetch(`/api/plan/${planId}`);
      const data = await response.json();
      setDetails((current) => new Map(current).set(planId, data));
    } catch {
      setError("Could not load plan detail.");
    } finally {
      setLoadingIds((current) => {
        const next = new Set(current);
        next.delete(planId);
        return next;
      });
    }
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
                placeholder="e.g. Google, Stripe, Freshworks"
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
                placeholder="e.g. SDE, Senior Software Engineer, ML"
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
                placeholder="Search skills e.g. React, Node.js..."
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
              {filteredSkills.length > 0 && (
                <div className="skill-bank">
                  {filteredSkills.map((skill) => (
                    <Button
                      key={skill.id}
                      className="skill"
                      variant="outline"
                      onClick={() => toggleSkill(skill.name)}
                    >
                      {skill.name}
                    </Button>
                  ))}
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
          {cards === null && <p className="muted">Results will appear here as cards.</p>}
          {cards && cards.length === 0 && <p>No matches found. Try broader inputs.</p>}
          {cards && cards.length > 0 && (
            <div className="card-grid">
              {cards.map((card) => {
                const isOpen = openPlanIds.has(card.planId);
                const isLoading = loadingIds.has(card.planId);
                const detail = details.get(card.planId);
                return (
                  <div key={card.planId} className={isOpen ? "plan-card is-open" : "plan-card"}>
                    <button className="plan-card-header" onClick={() => toggleCard(card.planId)}>
                      <div className="plan-card-titles">
                        <p className="plan-card-company">{card.companyName ?? "Any company"}</p>
                        <p className="plan-card-role">
                          {card.roleName} · <span className="muted">{card.seniority}</span>
                        </p>
                      </div>
                      <Badge className="round-badge">{card.roundCount} rounds</Badge>
                    </button>
                    {isOpen && (
                      <div className="plan-card-detail">
                        {isLoading && !detail && <p className="muted">Loading rounds…</p>}
                        {detail && (
                          <ol className="rounds">
                            {detail.rounds.map((round) => (
                              <li key={round.id}>
                                <strong>{round.title}</strong>
                                <span>
                                  {round.roundType}
                                  {round.durationMinutes ? ` · ${round.durationMinutes} min` : ""}
                                </span>
                                {round.description && <p>{round.description}</p>}
                              </li>
                            ))}
                          </ol>
                        )}
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
