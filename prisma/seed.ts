import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PlanStatus,
  PrismaClient,
  RoundType,
  Seniority,
  SkillCategory,
} from "@prisma/client";

const connectionString = process.env.ROUND_DB_URL;

if (!connectionString) {
  throw new Error("ROUND_DB_URL is required");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function upsertRole(
  roleSlug: string,
  roleName: string,
  seniority: Seniority,
  description: string
) {
  return prisma.roleProfile.upsert({
    where: { roleSlug_seniority: { roleSlug, seniority } },
    update: { roleName, description },
    create: { roleSlug, roleName, seniority, description },
  });
}

async function upsertSkill(name: string, category: SkillCategory) {
  return prisma.skill.upsert({
    where: { name },
    update: { category },
    create: { name, category },
  });
}

async function linkSkill(roleProfileId: string, skillId: string, weight: number) {
  await prisma.roleProfileSkill.upsert({
    where: { roleProfileId_skillId: { roleProfileId, skillId } },
    update: { weight },
    create: { roleProfileId, skillId, weight },
  });
}

async function upsertPlan(
  roleProfileId: string,
  companyId: string | null,
  adminNotes: string
) {
  const scopeKey = companyId ?? "global";
  return prisma.interviewPlan.upsert({
    where: { scopeKey_roleProfileId: { scopeKey, roleProfileId } },
    update: { companyId, status: PlanStatus.verified, adminNotes },
    create: {
      companyId,
      roleProfileId,
      scopeKey,
      status: PlanStatus.verified,
      adminNotes,
    },
  });
}

async function upsertRound(
  planId: string,
  position: number,
  roundType: RoundType,
  title: string,
  description: string,
  durationMinutes: number
) {
  await prisma.interviewRound.upsert({
    where: { planId_position: { planId, position } },
    update: { roundType, title, description, durationMinutes },
    create: { planId, position, roundType, title, description, durationMinutes },
  });
}

async function main() {
  const google = await prisma.company.upsert({
    where: { name: "Google" },
    update: {},
    create: { name: "Google" },
  });

  await prisma.company.upsert({
    where: { name: "Tata Consultancy Services" },
    update: {},
    create: { name: "Tata Consultancy Services" },
  });

  const frontendEntry = await upsertRole(
    "frontend_engineer",
    "Frontend Engineer",
    Seniority.entry,
    "Frontend role focused on UI, browser APIs, JavaScript, and component implementation."
  );
  const frontendMid = await upsertRole(
    "frontend_engineer",
    "Frontend Engineer",
    Seniority.mid,
    "Frontend role for candidates who can independently build and review production UI work."
  );
  const backendEntry = await upsertRole(
    "backend_engineer",
    "Backend Engineer",
    Seniority.entry,
    "Backend role focused on APIs, databases, services, and server-side design."
  );
  await upsertRole(
    "software_engineer",
    "Software Engineer",
    Seniority.entry,
    "General software engineering role for early-career candidates."
  );
  const fullstackEntry = await upsertRole(
    "fullstack_engineer",
    "Fullstack Engineer",
    Seniority.entry,
    "Role spanning frontend UI and backend API implementation."
  );
  const mlEntry = await upsertRole(
    "ml_engineer",
    "ML Engineer",
    Seniority.entry,
    "Engineering role focused on ML systems, data, and model integration."
  );
  const backendMid = await upsertRole(
    "backend_engineer",
    "Backend Engineer",
    Seniority.mid,
    "Mid-level backend role spanning API design, scaling, and data modelling."
  );
  const backendSenior = await upsertRole(
    "backend_engineer",
    "Backend Engineer",
    Seniority.senior,
    "Senior backend role with system design depth and cross-service ownership."
  );

  const skills = new Map(
    await Promise.all(
      (
        [
          ["JavaScript", SkillCategory.language],
          ["TypeScript", SkillCategory.language],
          ["React", SkillCategory.framework],
          ["Next.js", SkillCategory.framework],
          ["HTML", SkillCategory.concept],
          ["CSS", SkillCategory.concept],
          ["Node.js", SkillCategory.framework],
          ["REST APIs", SkillCategory.concept],
          ["PostgreSQL", SkillCategory.database],
          ["System Design", SkillCategory.concept],
          ["Python", SkillCategory.language],
          ["Machine Learning", SkillCategory.concept],
        ] as [string, SkillCategory][]
      ).map(async ([name, category]) => {
        const skill = await upsertSkill(name, category);
        return [name, skill] as const;
      })
    )
  );

  const links: Array<[string, string, number]> = [
    [frontendEntry.id, "JavaScript", 1.0],
    [frontendEntry.id, "TypeScript", 1.1],
    [frontendEntry.id, "React", 1.2],
    [frontendEntry.id, "Next.js", 1.0],
    [frontendEntry.id, "HTML", 0.8],
    [frontendEntry.id, "CSS", 0.8],
    [frontendMid.id, "JavaScript", 0.9],
    [frontendMid.id, "TypeScript", 1.2],
    [frontendMid.id, "React", 1.2],
    [frontendMid.id, "Next.js", 1.1],
    [frontendMid.id, "System Design", 0.8],
    [backendEntry.id, "Node.js", 1.0],
    [backendEntry.id, "REST APIs", 1.2],
    [backendEntry.id, "PostgreSQL", 1.0],
    [backendEntry.id, "System Design", 0.9],
  ];

  for (const [roleProfileId, skillName, weight] of links) {
    const skill = skills.get(skillName);
    if (skill) await linkSkill(roleProfileId, skill.id, weight);
  }

  const googleBackend = await upsertPlan(
    backendEntry.id,
    google.id,
    "Google backend entry plan entered by admin."
  );
  const defaultFrontendEntry = await upsertPlan(
    frontendEntry.id,
    null,
    "Default frontend entry plan."
  );
  const defaultFrontendMid = await upsertPlan(
    frontendMid.id,
    null,
    "Default frontend mid-level plan."
  );

  await upsertRound(
    googleBackend.id,
    1,
    RoundType.recruiter_screen,
    "Recruiter Screen",
    "Basic profile, eligibility, compensation, and availability discussion.",
    30
  );
  await upsertRound(
    googleBackend.id,
    2,
    RoundType.oa,
    "Online Assessment",
    "Timed coding and problem-solving screen.",
    90
  );
  await upsertRound(
    googleBackend.id,
    3,
    RoundType.coding_dsa,
    "DSA Coding Round",
    "Live coding round focused on data structures and algorithms.",
    60
  );
  await upsertRound(
    googleBackend.id,
    4,
    RoundType.backend_design,
    "Backend Design Round",
    "API, data model, storage, and service boundary discussion.",
    60
  );
  await upsertRound(
    googleBackend.id,
    5,
    RoundType.hiring_manager,
    "Hiring Manager Round",
    "Role fit, project depth, ownership, and team match.",
    45
  );

  await upsertRound(
    defaultFrontendEntry.id,
    1,
    RoundType.recruiter_screen,
    "Recruiter Screen",
    "Basic profile and eligibility discussion.",
    30
  );
  await upsertRound(
    defaultFrontendEntry.id,
    2,
    RoundType.oa,
    "Frontend Online Assessment",
    "JavaScript, browser fundamentals, and small UI problems.",
    75
  );
  await upsertRound(
    defaultFrontendEntry.id,
    3,
    RoundType.frontend_ui,
    "UI Coding Round",
    "Build or debug a small component with realistic state handling.",
    60
  );
  await upsertRound(
    defaultFrontendEntry.id,
    4,
    RoundType.hiring_manager,
    "Hiring Manager Round",
    "Project discussion, collaboration, and role fit.",
    45
  );

  await upsertRound(
    defaultFrontendMid.id,
    1,
    RoundType.recruiter_screen,
    "Recruiter Screen",
    "Profile, compensation, and project-fit discussion.",
    30
  );
  await upsertRound(
    defaultFrontendMid.id,
    2,
    RoundType.frontend_ui,
    "Frontend Coding Round",
    "Build and debug a production-style UI component.",
    75
  );
  await upsertRound(
    defaultFrontendMid.id,
    3,
    RoundType.system_design,
    "Frontend System Design",
    "Discuss state, rendering, performance, accessibility, and API boundaries.",
    60
  );
  await upsertRound(
    defaultFrontendMid.id,
    4,
    RoundType.behavioral,
    "Behavioral Round",
    "Ownership, collaboration, and incident/project depth.",
    45
  );
  await upsertRound(
    defaultFrontendMid.id,
    5,
    RoundType.hiring_manager,
    "Hiring Manager Round",
    "Scope fit, expectations, and team alignment.",
    45
  );

  // ── Amazon company ──────────────────────────────────────────────────────────

  const amazon = await prisma.company.upsert({
    where: { name: "Amazon" },
    update: {},
    create: { name: "Amazon" },
  });

  // ── software_engineer role profiles ─────────────────────────────────────────
  // entry already exists; upsert returns it unchanged
  const sweEntry = await upsertRole(
    "software_engineer",
    "Software Engineer",
    Seniority.entry,
    "General software engineering role for early-career candidates."
  );
  const sweMid = await upsertRole(
    "software_engineer",
    "Software Engineer",
    Seniority.mid,
    "Software engineering role for mid-level candidates with independent project ownership."
  );
  const sweSenior = await upsertRole(
    "software_engineer",
    "Software Engineer",
    Seniority.senior,
    "Senior software engineering role requiring system design depth and cross-team technical scope."
  );

  // ── skills for SWE roles ─────────────────────────────────────────────────────

  const javaSkill = await upsertSkill("Java", SkillCategory.language);
  const dsaSkill = await upsertSkill("Data Structures & Algorithms", SkillCategory.concept);
  const systemDesignSkill = skills.get("System Design")!;
  const pythonSkill = skills.get("Python")!;
  const restSkill = skills.get("REST APIs")!;
  const pgSkill = skills.get("PostgreSQL")!;

  const sweSkillLinks: Array<[string, string, number]> = [
    // entry
    [sweEntry.id, dsaSkill.id, 1.3],
    [sweEntry.id, pythonSkill.id, 1.0],
    [sweEntry.id, javaSkill.id, 1.0],
    // mid
    [sweMid.id, dsaSkill.id, 1.2],
    [sweMid.id, pythonSkill.id, 1.0],
    [sweMid.id, javaSkill.id, 1.0],
    [sweMid.id, systemDesignSkill.id, 1.0],
    [sweMid.id, restSkill.id, 0.9],
    // senior
    [sweSenior.id, systemDesignSkill.id, 1.3],
    [sweSenior.id, dsaSkill.id, 1.0],
    [sweSenior.id, pythonSkill.id, 1.0],
    [sweSenior.id, javaSkill.id, 1.0],
    [sweSenior.id, restSkill.id, 1.0],
    [sweSenior.id, pgSkill.id, 0.8],
  ];

  for (const [roleProfileId, skillId, weight] of sweSkillLinks) {
    await prisma.roleProfileSkill.upsert({
      where: { roleProfileId_skillId: { roleProfileId, skillId } },
      update: { weight },
      create: { roleProfileId, skillId, weight },
    });
  }

  // ── Google SWE plans ─────────────────────────────────────────────────────────

  // Entry (L3): recruiter → OA → 2× DSA → Googleyness  [5 rounds]
  const googleSweEntry = await upsertPlan(
    sweEntry.id,
    google.id,
    "Google SWE entry (L3) loop. Current process as of 2024/2025."
  );
  await upsertRound(googleSweEntry.id, 1, RoundType.recruiter_screen, "Recruiter Screen", "Role overview, background check, compensation range, and availability.", 30);
  await upsertRound(googleSweEntry.id, 2, RoundType.oa, "Online Assessment", "Two timed coding problems covering arrays, strings, and basic algorithms.", 60);
  await upsertRound(googleSweEntry.id, 3, RoundType.coding_dsa, "DSA Coding Round 1", "Live coding: medium-difficulty data structures and algorithms problem.", 45);
  await upsertRound(googleSweEntry.id, 4, RoundType.coding_dsa, "DSA Coding Round 2", "Live coding: second algorithm problem, may step up in complexity.", 45);
  await upsertRound(googleSweEntry.id, 5, RoundType.behavioral, "Googleyness & Leadership", "Collaboration, handling ambiguity, inclusion, and role-fit discussion.", 45);

  // Mid (L4/L5): recruiter → phone screen → 2× DSA → system design → Googleyness  [6 rounds]
  const googleSweMid = await upsertPlan(
    sweMid.id,
    google.id,
    "Google SWE mid-level (L4/L5) loop. Current process as of 2024/2025."
  );
  await upsertRound(googleSweMid.id, 1, RoundType.recruiter_screen, "Recruiter Screen", "Role overview, compensation, and timeline alignment.", 30);
  await upsertRound(googleSweMid.id, 2, RoundType.coding_dsa, "Phone Screen — Coding", "Remote live coding: one or two medium algorithm problems.", 60);
  await upsertRound(googleSweMid.id, 3, RoundType.coding_dsa, "DSA Coding Round 1", "Onsite live coding: medium-to-hard data structures and algorithms.", 45);
  await upsertRound(googleSweMid.id, 4, RoundType.coding_dsa, "DSA Coding Round 2", "Onsite live coding: second algorithm problem with follow-up optimizations.", 45);
  await upsertRound(googleSweMid.id, 5, RoundType.system_design, "System Design Round", "Design a scalable distributed system; covers APIs, storage, and trade-offs.", 60);
  await upsertRound(googleSweMid.id, 6, RoundType.behavioral, "Googleyness & Leadership", "Project ownership, cross-functional collaboration, and conflict resolution.", 45);

  // Senior (L5/L6): recruiter → phone screen → 2× DSA → 2× system design → behavioral  [7 rounds]
  const googleSweSenior = await upsertPlan(
    sweSenior.id,
    google.id,
    "Google SWE senior (L5/L6) loop. Current process as of 2024/2025."
  );
  await upsertRound(googleSweSenior.id, 1, RoundType.recruiter_screen, "Recruiter Screen", "Scope, compensation band, timeline, and senior-level expectations.", 30);
  await upsertRound(googleSweSenior.id, 2, RoundType.coding_dsa, "Phone Screen — Coding", "Remote live coding: medium-to-hard algorithm problem.", 60);
  await upsertRound(googleSweSenior.id, 3, RoundType.coding_dsa, "DSA Coding Round 1", "Onsite live coding: hard problem with optimization discussion.", 45);
  await upsertRound(googleSweSenior.id, 4, RoundType.coding_dsa, "DSA Coding Round 2", "Onsite live coding: hard problem, may involve graphs or dynamic programming.", 45);
  await upsertRound(googleSweSenior.id, 5, RoundType.system_design, "System Design Round 1", "Design a large-scale distributed system; deep-dive on consistency and fault tolerance.", 60);
  await upsertRound(googleSweSenior.id, 6, RoundType.system_design, "System Design Round 2", "Second system design: different domain or component-level deep dive.", 60);
  await upsertRound(googleSweSenior.id, 7, RoundType.behavioral, "Leadership & Culture", "Strategic impact, technical leadership, mentoring, and ownership of ambiguous problems.", 45);

  // ── Amazon SWE plans ─────────────────────────────────────────────────────────
  // Amazon embeds Leadership Principles (LP) questions in every coding round.

  // Entry (SDE I): recruiter → OA → 2× coding+LP → bar raiser  [5 rounds]
  const amazonSweEntry = await upsertPlan(
    sweEntry.id,
    amazon.id,
    "Amazon SWE entry (SDE I) loop. Current process as of 2024/2025."
  );
  await upsertRound(amazonSweEntry.id, 1, RoundType.recruiter_screen, "Recruiter Screen", "Background, team fit, compensation, and timeline.", 30);
  await upsertRound(amazonSweEntry.id, 2, RoundType.oa, "Online Assessment", "Two timed coding problems plus a work simulation or work style survey.", 90);
  await upsertRound(amazonSweEntry.id, 3, RoundType.coding_dsa, "Coding + Leadership Principles Round 1", "Live coding problem followed by LP behavioral questions (e.g. Customer Obsession, Ownership).", 60);
  await upsertRound(amazonSweEntry.id, 4, RoundType.coding_dsa, "Coding + Leadership Principles Round 2", "Second live coding problem with additional LP questions (e.g. Dive Deep, Bias for Action).", 60);
  await upsertRound(amazonSweEntry.id, 5, RoundType.behavioral, "Bar Raiser", "Independent assessor evaluates across all LP dimensions and decides whether the candidate raises the bar.", 60);

  // Mid (SDE II): recruiter → OA → 2× coding+LP → system design+LP → bar raiser  [6 rounds]
  const amazonSweMid = await upsertPlan(
    sweMid.id,
    amazon.id,
    "Amazon SWE mid-level (SDE II) loop. Current process as of 2024/2025."
  );
  await upsertRound(amazonSweMid.id, 1, RoundType.recruiter_screen, "Recruiter Screen", "Experience, team options, compensation, and role expectations.", 30);
  await upsertRound(amazonSweMid.id, 2, RoundType.oa, "Online Assessment", "Two timed coding problems.", 90);
  await upsertRound(amazonSweMid.id, 3, RoundType.coding_dsa, "Coding + Leadership Principles Round 1", "Live coding with LP questions focused on ownership and delivering results.", 60);
  await upsertRound(amazonSweMid.id, 4, RoundType.coding_dsa, "Coding + Leadership Principles Round 2", "Live coding with LP questions focused on dive deep and are right a lot.", 60);
  await upsertRound(amazonSweMid.id, 5, RoundType.system_design, "System Design + Leadership Principles", "Design a distributed service or platform component; LP questions on past architecture decisions.", 60);
  await upsertRound(amazonSweMid.id, 6, RoundType.behavioral, "Bar Raiser", "Deep LP dive across all 16 principles; overall bar assessment by an independent interviewer.", 60);

  // Senior (SDE III): recruiter → phone screen → 2× coding+LP → 2× system design → bar raiser  [7 rounds]
  const amazonSweSenior = await upsertPlan(
    sweSenior.id,
    amazon.id,
    "Amazon SWE senior (SDE III) loop. Current process as of 2024/2025."
  );
  await upsertRound(amazonSweSenior.id, 1, RoundType.recruiter_screen, "Recruiter Screen", "Seniority calibration, compensation, team options, and timeline.", 30);
  await upsertRound(amazonSweSenior.id, 2, RoundType.coding_dsa, "Phone Screen — Coding", "Remote live coding: medium-to-hard problem with LP follow-up questions.", 60);
  await upsertRound(amazonSweSenior.id, 3, RoundType.coding_dsa, "Coding + Leadership Principles Round 1", "Live coding with LP depth on ownership and long-term strategic impact.", 60);
  await upsertRound(amazonSweSenior.id, 4, RoundType.coding_dsa, "Coding + Leadership Principles Round 2", "Live coding with LP depth on think big and earn trust.", 60);
  await upsertRound(amazonSweSenior.id, 5, RoundType.system_design, "System Design Round 1", "Design a large-scale distributed system; focus on availability, consistency, and failure modes.", 60);
  await upsertRound(amazonSweSenior.id, 6, RoundType.system_design, "System Design Round 2", "Second system design: operational excellence, scaling strategy, and data model deep dive.", 60);
  await upsertRound(amazonSweSenior.id, 7, RoundType.behavioral, "Bar Raiser", "Cross-functional LP assessment; evaluates senior impact, mentoring, and raising the overall bar.", 60);

  // ── Fullstack engineer skill links ──────────────────────────────────────────
  const fullstackSkillLinks: Array<[string, string, number]> = [
    [fullstackEntry.id, "JavaScript", 1.1],
    [fullstackEntry.id, "TypeScript", 1.1],
    [fullstackEntry.id, "React", 1.0],
    [fullstackEntry.id, "Next.js", 1.0],
    [fullstackEntry.id, "Node.js", 1.1],
    [fullstackEntry.id, "REST APIs", 1.0],
    [fullstackEntry.id, "PostgreSQL", 0.9],
  ];
  for (const [roleProfileId, skillName, weight] of fullstackSkillLinks) {
    const skill = skills.get(skillName);
    if (skill) await linkSkill(roleProfileId, skill.id, weight);
  }
  // Java links for fullstack (Java was added earlier in the SWE block)
  const javaSkill2 = await prisma.skill.findUnique({ where: { name: "Java" } });
  if (javaSkill2) await linkSkill(fullstackEntry.id, javaSkill2.id, 0.9);

  // ── Global fallback plans (one per role+seniority so the search never empties) ──
  type RoundSeed = [number, RoundType, string, string, number];
  const globalPlans: Array<{ role: string; notes: string; rounds: RoundSeed[] }> = [
    {
      role: sweEntry.id,
      notes: "Generic entry SWE loop used as default when no company-specific plan exists.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Background and basic role fit discussion.", 30],
        [2, RoundType.oa, "Online Assessment", "Two coding problems.", 75],
        [3, RoundType.coding_dsa, "DSA Coding Round", "Live coding focused on data structures and algorithms.", 60],
        [4, RoundType.behavioral, "Behavioral Round", "Project depth, collaboration, and role-fit discussion.", 45],
      ],
    },
    {
      role: sweMid.id,
      notes: "Generic mid-level SWE loop used as default.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Role overview and compensation alignment.", 30],
        [2, RoundType.coding_dsa, "DSA Coding Round 1", "Live coding with medium-to-hard algorithms.", 60],
        [3, RoundType.coding_dsa, "DSA Coding Round 2", "Second algorithm problem with optimization discussion.", 60],
        [4, RoundType.system_design, "System Design Round", "Design a scalable distributed system.", 60],
        [5, RoundType.behavioral, "Behavioral Round", "Project ownership and collaboration.", 45],
      ],
    },
    {
      role: sweSenior.id,
      notes: "Generic senior SWE loop used as default.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Senior role calibration.", 30],
        [2, RoundType.coding_dsa, "DSA Coding Round 1", "Hard algorithms.", 60],
        [3, RoundType.coding_dsa, "DSA Coding Round 2", "Hard algorithms with optimization deep dive.", 60],
        [4, RoundType.system_design, "System Design Round 1", "Large-scale distributed design.", 60],
        [5, RoundType.system_design, "System Design Round 2", "Second design covering operational excellence.", 60],
        [6, RoundType.behavioral, "Leadership & Culture", "Strategic impact, mentoring, technical leadership.", 45],
      ],
    },
    {
      role: fullstackEntry.id,
      notes: "Generic entry fullstack loop.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Role overview and stack alignment.", 30],
        [2, RoundType.frontend_ui, "Frontend Coding", "Build a small interactive component.", 60],
        [3, RoundType.backend_design, "Backend Coding", "Build an endpoint with persistence.", 60],
        [4, RoundType.behavioral, "Behavioral Round", "Project depth and collaboration.", 45],
      ],
    },
    {
      role: backendEntry.id,
      notes: "Generic entry backend loop.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Role overview.", 30],
        [2, RoundType.coding_dsa, "DSA Coding Round", "Algorithms with backend flavour.", 60],
        [3, RoundType.backend_design, "Backend Design", "API + data model design discussion.", 60],
        [4, RoundType.behavioral, "Behavioral Round", "Project ownership.", 45],
      ],
    },
    {
      role: backendMid.id,
      notes: "Generic mid backend loop.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Role overview.", 30],
        [2, RoundType.coding_dsa, "DSA Coding Round", "Algorithms.", 60],
        [3, RoundType.backend_design, "Backend Design", "API and storage design.", 60],
        [4, RoundType.system_design, "System Design Round", "Distributed system design.", 60],
        [5, RoundType.behavioral, "Behavioral Round", "Ownership and conflict resolution.", 45],
      ],
    },
    {
      role: backendSenior.id,
      notes: "Generic senior backend loop.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Senior calibration.", 30],
        [2, RoundType.coding_dsa, "DSA Coding Round", "Hard algorithms.", 60],
        [3, RoundType.backend_design, "Backend Design", "Service design deep dive.", 60],
        [4, RoundType.system_design, "System Design Round 1", "Large-scale distributed design.", 60],
        [5, RoundType.system_design, "System Design Round 2", "Operational excellence and data modelling.", 60],
        [6, RoundType.behavioral, "Leadership & Culture", "Senior impact and mentoring.", 45],
      ],
    },
    {
      role: mlEntry.id,
      notes: "Generic entry ML engineer loop.",
      rounds: [
        [1, RoundType.recruiter_screen, "Recruiter Screen", "Role overview.", 30],
        [2, RoundType.coding_dsa, "DSA Coding Round", "Algorithms with ML flavour.", 60],
        [3, RoundType.backend_design, "ML System Design", "Feature pipelines, model serving, training/eval loops.", 60],
        [4, RoundType.behavioral, "Behavioral Round", "Ownership and collaboration.", 45],
      ],
    },
  ];

  for (const plan of globalPlans) {
    const created = await upsertPlan(plan.role, null, plan.notes);
    for (const [pos, type, title, desc, dur] of plan.rounds) {
      await upsertRound(created.id, pos, type, title, desc, dur);
    }
  }

  // ── Embed names into vector columns ─────────────────────────────────────────
  // Re-embed only rows whose embedding column is NULL — idempotent across reruns.
  const { embed, toPgVectorLiteral } = await import("../lib/embeddings");

  console.log("Embedding company names...");
  const companiesToEmbed = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM "Company" WHERE embedding IS NULL
  `;
  for (const c of companiesToEmbed) {
    const vec = toPgVectorLiteral(await embed(c.name));
    await prisma.$executeRawUnsafe(
      `UPDATE "Company" SET embedding = $1::vector WHERE id = $2`,
      vec,
      c.id
    );
  }

  console.log("Embedding role profiles...");
  const rolesToEmbed = await prisma.$queryRaw<{ id: string; roleName: string }[]>`
    SELECT id, "roleName" FROM "RoleProfile" WHERE embedding IS NULL
  `;
  for (const r of rolesToEmbed) {
    const vec = toPgVectorLiteral(await embed(r.roleName));
    await prisma.$executeRawUnsafe(
      `UPDATE "RoleProfile" SET embedding = $1::vector WHERE id = $2`,
      vec,
      r.id
    );
  }

  console.log("Embedding skills...");
  const skillsToEmbed = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM "Skill" WHERE embedding IS NULL
  `;
  for (const s of skillsToEmbed) {
    const vec = toPgVectorLiteral(await embed(s.name));
    await prisma.$executeRawUnsafe(
      `UPDATE "Skill" SET embedding = $1::vector WHERE id = $2`,
      vec,
      s.id
    );
  }

  // ── Recompute cachedRoundCount as a safety net beneath the trigger ──────────
  await prisma.$executeRawUnsafe(`
    UPDATE "InterviewPlan" p
    SET "cachedRoundCount" = sub.cnt
    FROM (
      SELECT "planId", count(*)::int AS cnt
      FROM "InterviewRound"
      GROUP BY "planId"
    ) sub
    WHERE sub."planId" = p.id
  `);

  console.log(
    `Embedded ${companiesToEmbed.length} companies, ${rolesToEmbed.length} roles, ${skillsToEmbed.length} skills. Recomputed round counts.`
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Seeded interview rounds prototype data");
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
