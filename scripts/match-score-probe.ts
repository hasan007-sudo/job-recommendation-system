// Probe: compute the new match score (glossed semantic skills + capability
// evidence, 65/35 blend) for one candidate profile against one job, printing
// the full breakdown. Run:
//   npx tsx --env-file=.env scripts/match-score-probe.ts [jobId]
import { prisma } from "../lib/prisma";
import { embed } from "../lib/embeddings";

const JOB_ID = process.argv[2] ?? "cmq7qxif80009h605q5si77dg";

const SEMANTIC_SKILL_MIN = 0.3;
const PROJECT_EVIDENCE_MIN = 0.1;
const PROJECT_EVIDENCE_MAX = 0.35;
const SKILL_WEIGHT = 0.65;
const PROJECT_WEIGHT = 0.35;

// Aswathy B — skills as the updated parser would emit them (incl. soft skills).
const candidateSkills = [
  "Python",
  "SQL",
  "Machine learning",
  "Data Cleansing",
  "Data Preprocessing",
  "Data Visualisation",
  "Deep Learning",
  "Git",
  "Linux",
  "Pandas",
  "NumPy",
  "Scikit-learn",
  "Matplotlib",
  "Seaborn",
  "Communication",
  "Team Collaboration",
  "Problem solving and analytical thinking",
];

// Project evidence text = description + keywords (see ARCHITECTURE.md "Candidate embeddings").
const candidateProjects = [
  "Developed a predictive model to estimate the critical temperature of superconductors based on atomic properties. Used regression models including Linear Regression, Polynomial Regression, Lasso, Ridge, ElasticNet, Decision Trees, Random Forest and AdaBoost. Applied feature scaling, PCA for dimensionality reduction, and cross-validation. Python, Scikit-learn, Pandas, NumPy, Matplotlib. Keywords: machine learning, regression, PCA, cross-validation, model validation",
  "Classified car images into categories using Convolutional Neural Networks, with Batch Normalization and Dropout to reduce overfitting. Fine-tuned models with selective layer freezing. Evaluated with accuracy, precision, recall, F1-score. Python, TensorFlow, Keras. Keywords: deep learning, CNN, image classification, TensorFlow",
  "Researched cybersecurity risks and vulnerabilities faced by children and teens, examining the importance of cybersecurity education for young users. Keywords: cybersecurity, digital threats, online safety research",
  "Implemented the Quine-McCluskey method for digital logic design: prime implicant tables and chart generation to simplify Boolean expressions. Keywords: digital logic, boolean algebra, Quine-McCluskey",
];

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cos(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // Titan vectors are normalized
}

// One batched OpenRouter call: skill name -> one-line gloss (same provider the
// resume parser uses; this mirrors what import-time glossing will do).
async function glossSkills(names: string[]): Promise<Map<string, string>> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
  const model = process.env.LLM_MODEL || "openai/gpt-4o-mini";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You write one-line glosses for skill names found in job postings and resumes. For each input skill, return a short description (8-15 words) of what the skill is, expanding acronyms and naming the domain. Reply as JSON: {"glosses": {"<skill name>": "<Name (expanded)>: <description>"}}. Example: {"glosses": {"AWS": "AWS (Amazon Web Services): cloud computing platform, cloud infrastructure services"}}',
        },
        { role: "user", content: JSON.stringify({ skills: names }) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Gloss request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return new Map(Object.entries(parsed.glosses as Record<string, string>));
}

async function main() {
  const job = await prisma.job.findUnique({
    where: { id: JOB_ID },
    select: {
      jobTitle: true,
      roleSummary: true,
      requiredSkills: true,
      keyResponsibilities: true,
      roundTechnical: true,
      company: { select: { name: true } },
    },
  });
  if (!job) throw new Error(`Job ${JOB_ID} not found`);
  console.log(`\n=== ${job.company.name} — ${job.jobTitle} ===\n`);

  // ---- Required skill score -------------------------------------------------
  const jobSkillNames = (job.requiredSkills ?? "")
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const glosses = await glossSkills([...jobSkillNames, ...candidateSkills]);
  console.log("Glosses:");
  for (const [name, gloss] of glosses) console.log(`  ${name.padEnd(42)} ${gloss}`);

  const jobVecs = await Promise.all(jobSkillNames.map((n) => embed(glosses.get(n) ?? n)));
  const candVecs = await Promise.all(candidateSkills.map((n) => embed(glosses.get(n) ?? n)));
  const candTokens = candidateSkills.map(normalizeToken);

  console.log(`\nRequired-skill coverage (SEMANTIC_SKILL_MIN = ${SEMANTIC_SKILL_MIN}):`);
  let covered = 0;
  for (let i = 0; i < jobSkillNames.length; i++) {
    const tok = normalizeToken(jobSkillNames[i]);
    const exactIdx = candTokens.findIndex((c) => c === tok);
    let bestSim = -1;
    let bestIdx = -1;
    for (let j = 0; j < candVecs.length; j++) {
      const s = cos(jobVecs[i], candVecs[j]);
      if (s > bestSim) {
        bestSim = s;
        bestIdx = j;
      }
    }
    const isCovered = exactIdx >= 0 || bestSim >= SEMANTIC_SKILL_MIN;
    if (isCovered) covered++;
    const via =
      exactIdx >= 0
        ? `exact: ${candidateSkills[exactIdx]}`
        : bestSim >= SEMANTIC_SKILL_MIN
          ? `semantic: ${candidateSkills[bestIdx]} (${bestSim.toFixed(3)})`
          : `best was ${candidateSkills[bestIdx]} (${bestSim.toFixed(3)})`;
    console.log(`  ${isCovered ? "✓" : "✗"} ${jobSkillNames[i].padEnd(20)} ${via}`);
  }
  const requiredSkillScore = (covered / jobSkillNames.length) * 100;
  console.log(`  → requiredSkillScore = ${covered}/${jobSkillNames.length} = ${requiredSkillScore.toFixed(1)}`);

  // ---- Project evidence score ----------------------------------------------
  // requiredSkills is deliberately excluded: skills already own 65% of the
  // blend, and including them here would double-count (projects channel would
  // partially echo the skills channel).
  const capabilities: string[] = [
    ...(job.keyResponsibilities ?? "").split(";").map((s) => s.trim()).filter(Boolean),
    ...(job.roleSummary ? [job.roleSummary.trim()] : []),
    ...(job.roundTechnical ? [job.roundTechnical.trim()] : []),
  ];

  const capVecs = await Promise.all(capabilities.map((c) => embed(c)));
  const projVecs = await Promise.all(candidateProjects.map((p) => embed(p)));

  console.log(
    `\nCapability evidence (window ${PROJECT_EVIDENCE_MIN}–${PROJECT_EVIDENCE_MAX} → 0–100):`,
  );
  const evidences: number[] = [];
  for (let i = 0; i < capabilities.length; i++) {
    let bestSim = -1;
    let bestIdx = -1;
    for (let j = 0; j < projVecs.length; j++) {
      const s = cos(capVecs[i], projVecs[j]);
      if (s > bestSim) {
        bestSim = s;
        bestIdx = j;
      }
    }
    const rescaled =
      Math.max(
        0,
        Math.min(1, (bestSim - PROJECT_EVIDENCE_MIN) / (PROJECT_EVIDENCE_MAX - PROJECT_EVIDENCE_MIN)),
      ) * 100;
    evidences.push(rescaled);
    console.log(
      `  [${rescaled.toFixed(0).padStart(3)}] cos=${bestSim.toFixed(3)} via project ${bestIdx + 1} | ${capabilities[i].slice(0, 70)}`,
    );
  }
  const projectEvidenceScore = evidences.reduce((a, b) => a + b, 0) / evidences.length;
  console.log(`  → projectEvidenceScore = AVG = ${projectEvidenceScore.toFixed(1)}`);

  // ---- Blend ----------------------------------------------------------------
  const matchScore = Math.round(
    SKILL_WEIGHT * requiredSkillScore + PROJECT_WEIGHT * projectEvidenceScore,
  );
  console.log(
    `\nmatchScore = ${SKILL_WEIGHT} × ${requiredSkillScore.toFixed(1)} + ${PROJECT_WEIGHT} × ${projectEvidenceScore.toFixed(1)} = ${matchScore}%\n`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
