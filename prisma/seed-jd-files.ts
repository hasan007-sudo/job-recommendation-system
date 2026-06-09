import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { embed, toPgVectorLiteral } from "../lib/embeddings";

// One-off seed for two local JD sources (Business Advisor.pdf, GenAI_Ideal_Employee_Profile.docx).
// Parsed values are inlined — no runtime PDF/DOCX parsing. Reuses the same field shape,
// FIXED_ROUND_PATTERN, and embedding backfill as prisma/import-jobs.ts.

const FIXED_ROUND_PATTERN = "Screening + Behavioural + Technical + Culture fit";

const targetUrl = process.env.ROUND_DB_URL;
if (!targetUrl) throw new Error("ROUND_DB_URL is required");

const target = new PrismaClient({ adapter: new PrismaPg({ connectionString: targetUrl }) });

type SeedJob = {
  company: string;
  jobTitle: string;
  roleCategory: string | null;
  roleType: string | null;
  location: string | null;
  workMode: string | null;
  requiredSkills: string | null;
  educationRequirement: string | null;
  roleSummary: string | null;
  keyResponsibilities: string | null;
  fullJobDescription: string | null;
  roundScreening: string;
  roundBehavioural: string;
  roundTechnical: string;
  roundCultureFit: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  salaryInrMinPerYear: number | null;
  salaryInrMaxPerYear: number | null;
  sourceRowHash: string;
};

// Shared "Common DNA" traits from the DOCX — used as the culture-fit round for all 4 archetypes.
const COMMON_DNA = "AI Fluency; Learning Velocity; Critical Judgment; Human + AI Teaming; Responsible AI";

const SEED_JOBS: SeedJob[] = [
  {
    company: "Vakilsearch",
    jobTitle: "Business Advisor",
    roleCategory: "Business Development",
    roleType: "Sales",
    location: "Chennai",
    workMode: null,
    requiredSkills: "Communication; English; Hindi; Sales; Negotiation",
    educationRequirement: "Any graduation",
    roleSummary:
      "Understand client requirements and suggest suitable solutions through our services, maintain good relationships with clients, and grow the existing database.",
    keyResponsibilities:
      "Regular follow up on leads; Understand client requirements and suggest suitable solutions; Convert prospective leads into sales; Close sales and achieve monthly targets; Develop contacts and build a database; Maintain relationships with existing clients; Cross-sell available services.",
    fullJobDescription:
      "Vakilsearch — Business Advisor (Business Development). Job Summary: Understand client requirements and suggest suitable solutions through our services, maintain a good relationship with clients and build the existing database. Responsibilities: regular follow up on leads; understand client requirements and suggest suitable solutions; convert prospective leads into sales; close sales and achieve monthly targets; develop contacts and build a database; maintain the relationship with existing clients; cross sell different services. Qualification: any graduation. Experience: 0–3 years in sales. Skills: excellent communication; proficiency in English & Hindi (must); interest in sales; dynamic and energetic personality; convincing and negotiation skills. Location: Chennai. CTC: 1.8–4 LPA.",
    roundScreening: "Communication skills; English & Hindi proficiency; Interest in sales",
    roundBehavioural: "Negotiation; Convincing skills; Dynamic & energetic attitude",
    roundTechnical: "Lead follow-up & conversion; Solution selling; Cross-selling services",
    roundCultureFit: "Client relationship management; Monthly target orientation",
    experienceMinYears: 0,
    experienceMaxYears: 3,
    salaryInrMinPerYear: 180000,
    salaryInrMaxPerYear: 400000,
    sourceRowHash: "seed:vakilsearch:business-advisor",
  },
  {
    company: "Change Pond",
    jobTitle: "QA Tester",
    roleCategory: "IT Services - Gen AI",
    roleType: "AI-Augmented Quality Engineer",
    location: null,
    workMode: null,
    requiredSkills:
      "Prompt engineering for test gen; AI-assisted test automation; LLM output validation; Risk-based testing; Agentic workflow validation; Hallucination & bias checks",
    educationRequirement: null,
    roleSummary:
      "AI-Augmented Quality Engineer — validates non-deterministic AI outputs, tests agentic workflows, and safeguards quality, bias, and safety across AI-driven flows.",
    keyResponsibilities:
      "Write prompts to auto-generate test cases; Build regression suites with AI copilots; Validate accuracy, relevance & consistency of AI responses; Detect factual drift, bias and unsafe content; Test multi-agent pipelines end-to-end; Monitor training and inference data quality.",
    fullJobDescription:
      "Change Pond — QA / Tester (AI-Augmented Quality Engineer). Core Skills: prompt engineering for test generation, AI-assisted test automation, LLM output validation, risk-based testing. New Capabilities: test AI model behaviour, hallucination & bias checks, agentic workflow validation, GenAI tool orchestration. Data & Domain: data quality & drift detection, domain-specific test design, synthetic data generation. Mindset Shifts: from scripted to exploratory testing, AI output auditor, collaborative with AI copilots.",
    roundScreening: "Software testing fundamentals; Risk-based testing mindset; Familiarity with AI/LLM-driven testing",
    roundBehavioural: "Scripted to exploratory testing; AI output auditor; Collaboration with AI copilots",
    roundTechnical:
      "Prompt engineering for test generation; AI-assisted test automation; LLM output validation; Test AI model behaviour; Hallucination & bias checks; Agentic workflow validation; GenAI tool orchestration; Data quality & drift detection; Synthetic data generation",
    roundCultureFit: COMMON_DNA,
    experienceMinYears: null,
    experienceMaxYears: null,
    salaryInrMinPerYear: null,
    salaryInrMaxPerYear: null,
    sourceRowHash: "seed:changepond:qa-tester",
  },
  {
    company: "Change Pond",
    jobTitle: "Developer",
    roleCategory: "IT Services - Gen AI",
    roleType: "AI-Native Software Engineer",
    location: null,
    workMode: null,
    requiredSkills:
      "Prompt & context engineering; AI pair programming; LLM API integration; Code review of AI output; Agentic workflow design; RAG & vector DB fundamentals; AI security & guardrails",
    educationRequirement: null,
    roleSummary:
      "AI-Native Software Engineer — orchestrates and verifies AI-generated code, designs agentic pipelines and RAG architectures, and embeds responsible-AI guardrails.",
    keyResponsibilities:
      "Craft precise prompts and context windows; Work alongside AI pair-programming tools; Integrate OpenAI, Anthropic and Gemini APIs; Critically review, refactor and validate AI-generated code; Build multi-step autonomous agent pipelines; Design retrieval-augmented generation architectures; Implement input validation, rate limiting and content filters.",
    fullJobDescription:
      "Change Pond — Developer (AI-Native Software Engineer). Core Skills: prompt & context engineering, AI pair programming, LLM API integration, code review of AI output. New Capabilities: agentic workflow design, RAG & vector DB fundamentals, fine-tuning & model selection, AI security & guardrails. Architecture: systems thinking, feedback loop design, data pipeline fluency. Mindset Shifts: director not just coder, responsible AI coding, deep AI curiosity.",
    roundScreening: "Programming fundamentals; Familiarity with AI pair-programming tools; Code review basics",
    roundBehavioural: "Director not just coder; Responsible AI coding; Deep AI curiosity",
    roundTechnical:
      "Prompt & context engineering; LLM API integration; Code review of AI output; Agentic workflow design; RAG & vector DB fundamentals; Fine-tuning & model selection; AI security & guardrails; Systems thinking; Feedback loop design; Data pipeline fluency",
    roundCultureFit: COMMON_DNA,
    experienceMinYears: null,
    experienceMaxYears: null,
    salaryInrMinPerYear: null,
    salaryInrMaxPerYear: null,
    sourceRowHash: "seed:changepond:developer",
  },
  {
    company: "Change Pond",
    jobTitle: "Business Analyst",
    roleCategory: "IT Services - Gen AI",
    roleType: "AI-Enabled Solution Strategist",
    location: null,
    workMode: null,
    requiredSkills:
      "AI use-case ideation; Process automation mapping; Data literacy & storytelling; Requirements for AI systems; AI ROI & feasibility analysis; Human-AI workflow design",
    educationRequirement: null,
    roleSummary:
      "AI-Enabled Solution Strategist — identifies where GenAI creates business value, co-designs human-AI workflows, and builds the ROI case for AI investment.",
    keyResponsibilities:
      "Identify where GenAI creates business value; Map human workflows to AI-augmentation opportunities; Interpret data outputs and present AI insights to stakeholders; Write specs accounting for non-deterministic AI behaviour; Build business cases for AI investment; Design human-AI complementary workflows; Lead AI adoption and change management.",
    fullJobDescription:
      "Change Pond — Business Analyst (AI-Enabled Solution Strategist). Core Skills: AI use-case ideation, process automation mapping, data literacy & storytelling, requirements for AI systems. New Capabilities: AI ROI & feasibility analysis, prompt-based prototyping, human-AI workflow design, change management for AI. Stakeholder: AI ethics & responsible use, cross-functional facilitation, client AI literacy building. Mindset Shifts: from requirements to co-design, bridge builder, AI literacy champion.",
    roundScreening: "Business analysis fundamentals; AI use-case awareness; Stakeholder communication",
    roundBehavioural: "Requirements to co-design; Bridge builder; AI literacy champion",
    roundTechnical:
      "AI use-case ideation; Process automation mapping; Requirements for AI systems; AI ROI & feasibility analysis; Prompt-based prototyping; Human-AI workflow design; Change management for AI; Data literacy & storytelling",
    roundCultureFit: COMMON_DNA,
    experienceMinYears: null,
    experienceMaxYears: null,
    salaryInrMinPerYear: null,
    salaryInrMaxPerYear: null,
    sourceRowHash: "seed:changepond:business-analyst",
  },
  {
    company: "Change Pond",
    jobTitle: "Practice Leader",
    roleCategory: "IT Services - Gen AI",
    roleType: "AI Transformation Champion",
    location: null,
    workMode: null,
    requiredSkills:
      "GenAI strategy & roadmapping; Practice P&L with AI leverage; Talent re-skilling leadership; AI governance & policy setting; Outcome-based pricing; AI vendor & partner management",
    educationRequirement: null,
    roleSummary:
      "AI Transformation Champion — defines practice-wide AI strategy, reshapes delivery economics, sets responsible-AI governance, and advises clients at the C-suite level.",
    keyResponsibilities:
      "Define practice-wide AI adoption strategy and milestones; Reshape delivery economics with AI productivity gains; Build structured upskilling programs across roles; Develop AI frameworks, accelerators and assets; Set guardrails and responsible-AI policies; Redesign teams for AI-augmented delivery; Shift to outcome-based engagement models; Advise C-suite client stakeholders on AI.",
    fullJobDescription:
      "Change Pond — Practice Leader (AI Transformation Champion). Core Skills: GenAI strategy & roadmapping, practice P&L with AI leverage, talent re-skilling leadership, thought leadership & IP creation. New Capabilities: AI governance & policy setting, new delivery model design, outcome-based pricing with AI, AI vendor & partner management. Leadership: AI ethics oversight, innovation culture building, client advisory on AI. Mindset Shifts: headcount to outcomes, learning practice builder, ethics & quality bar setter.",
    roundScreening: "Delivery leadership fundamentals; AI strategy awareness; Stakeholder & client communication",
    roundBehavioural: "Headcount to outcomes; Learning practice builder; Ethics & quality bar setter",
    roundTechnical:
      "GenAI strategy & roadmapping; Practice P&L with AI leverage; AI governance & policy setting; New delivery model design; Outcome-based pricing with AI; AI vendor & partner management; Talent re-skilling leadership",
    roundCultureFit: COMMON_DNA,
    experienceMinYears: null,
    experienceMaxYears: null,
    salaryInrMinPerYear: null,
    salaryInrMaxPerYear: null,
    sourceRowHash: "seed:changepond:practice-leader",
  },
];

// Same composite as import-jobs.ts: title + roleType + summary + skills.
function embeddingText(job: SeedJob): string {
  return `${job.jobTitle}. ${job.roleType ?? ""}. ${job.roleSummary ?? ""}. Skills: ${job.requiredSkills ?? ""}`;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const companyNames = Array.from(new Set(SEED_JOBS.map((j) => j.company)));

  console.log(
    JSON.stringify(
      {
        mode: confirm ? "confirm" : "dry-run",
        jobs: SEED_JOBS.length,
        companies: companyNames,
      },
      null,
      2
    )
  );

  if (!confirm) {
    await target.$disconnect();
    console.log("Dry run only. Re-run with --confirm to write to ROUND_DB_URL.");
    return;
  }

  // 1. Companies
  await target.company.createMany({
    data: companyNames.map((name) => ({ name })),
    skipDuplicates: true,
  });
  const companies = await target.company.findMany({ where: { name: { in: companyNames } } });
  const companyByName = new Map(companies.map((c) => [c.name, c.id]));

  // 2. Jobs
  const jobData = SEED_JOBS.map((job) => ({
    companyId: companyByName.get(job.company)!,
    jobTitle: job.jobTitle,
    location: job.location,
    roleCategory: job.roleCategory,
    roleType: job.roleType,
    workMode: job.workMode,
    requiredSkills: job.requiredSkills,
    educationRequirement: job.educationRequirement,
    roleSummary: job.roleSummary,
    keyResponsibilities: job.keyResponsibilities,
    fullJobDescription: job.fullJobDescription,
    roundScreening: job.roundScreening,
    roundBehavioural: job.roundBehavioural,
    roundTechnical: job.roundTechnical,
    roundCultureFit: job.roundCultureFit,
    focusRoundPattern: FIXED_ROUND_PATTERN,
    experienceMinYears: job.experienceMinYears,
    experienceMaxYears: job.experienceMaxYears,
    salaryInrMinPerYear: job.salaryInrMinPerYear,
    salaryInrMaxPerYear: job.salaryInrMaxPerYear,
    sourceRowHash: job.sourceRowHash,
  }));

  await target.job.createMany({ data: jobData, skipDuplicates: true });

  // 3. Embeddings — backfill the seeded rows that have none.
  const textByHash = new Map(SEED_JOBS.map((j) => [j.sourceRowHash, embeddingText(j)]));
  const hashes = SEED_JOBS.map((j) => j.sourceRowHash);
  const pending = await target.$queryRaw<{ id: string; sourceRowHash: string }[]>`
    SELECT id, "sourceRowHash" FROM "Job"
    WHERE embedding IS NULL AND "sourceRowHash" = ANY(${hashes})
  `;

  let done = 0;
  for (const row of pending) {
    const text = textByHash.get(row.sourceRowHash);
    if (!text) continue;
    const vec = await embed(text);
    await target.$executeRawUnsafe(
      `UPDATE "Job" SET embedding = $1::vector WHERE id = $2`,
      toPgVectorLiteral(vec),
      row.id
    );
    done++;
  }

  await target.$disconnect();
  console.log(`Seeded ${jobData.length} jobs across ${companyNames.length} companies. Embedded ${done}.`);
}

main().catch(async (error) => {
  console.error(error);
  await target.$disconnect();
  process.exit(1);
});
