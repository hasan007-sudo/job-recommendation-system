"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Check, Loader2, Plus, X } from "lucide-react";
import {
  deriveSearchInput,
  EMPTY_PROFILE,
  type OnboardingProfile,
} from "../../lib/onboarding";
import { Badge } from "../../components/shadcn/badge";
import { Button } from "../../components/shadcn/button";
import { Card } from "../../components/shadcn/card";
import { Input } from "../../components/shadcn/input";
import { Label } from "../../components/shadcn/label";
import { StepIndicator } from "../../components/shadcn/step-indicator";

type Step = "upload" | "profile";
type Mode = "parsed" | "manual";
type ParseState = "idle" | "parsing" | "done" | "error";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [mode, setMode] = useState<Mode>("parsed");
  const [profile, setProfile] = useState<OnboardingProfile>(EMPTY_PROFILE);
  const [fileName, setFileName] = useState("");
  const [parseState, setParseState] = useState<ParseState>("idle");
  const [parseSecs, setParseSecs] = useState(0);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setFileName(file.name);
    setParseState("parsing");
    setError("");
    const started = Date.now();
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/onboarding/parse", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error ?? "Could not parse this résumé.");
      setProfile(data.profile);
      setParseSecs(Math.max(1, Math.round((Date.now() - started) / 1000)));
      setParseState("done");
    } catch (e) {
      setParseState("error");
      setError(e instanceof Error ? e.message : "Could not parse this résumé.");
    }
  }

  function findMatches() {
    sessionStorage.setItem(
      "rounds:autosearch",
      JSON.stringify(deriveSearchInput(profile)),
    );
    router.push("/");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col px-6 pb-36 pt-6">
      <header className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="auto"
          onClick={() =>
            step === "profile" ? setStep("upload") : router.push("/")
          }
          className="font-mono gap-1.5 text-[11px] uppercase tracking-[0.18em]"
        >
          <ArrowLeft size={13} strokeWidth={1.5} />
          Back
        </Button>
        <StepIndicator current={step === "upload" ? 1 : 2} total={3} />
      </header>

      <div className="anim-in mt-10" key={step}>
        {step === "upload" ? (
          <UploadStep
            inputRef={inputRef}
            fileName={fileName}
            parseState={parseState}
            parseSecs={parseSecs}
            error={error}
            onPick={() => inputRef.current?.click()}
            onFile={handleFile}
            onContinue={() => {
              setMode("parsed");
              setStep("profile");
            }}
            onNoResume={() => {
              setProfile(EMPTY_PROFILE);
              setMode("manual");
              setStep("profile");
            }}
          />
        ) : (
          <ProfileStep
            mode={mode}
            profile={profile}
            parseSecs={parseSecs}
            setProfile={setProfile}
          />
        )}
      </div>

      <BottomBar
        disabled={step === "upload" ? parseState !== "done" : false}
        label={
          step === "upload"
            ? "Continue"
            : mode === "parsed"
              ? "Looks right · find my matches"
              : "Done · find my matches"
        }
        onClick={
          step === "upload"
            ? () => {
                setMode("parsed");
                setStep("profile");
              }
            : findMatches
        }
      />
    </main>
  );
}

// -----------------------------------------------------------------------------
// Step 1 — upload
// -----------------------------------------------------------------------------

function UploadStep({
  inputRef,
  fileName,
  parseState,
  parseSecs,
  error,
  onPick,
  onFile,
  onContinue,
  onNoResume,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  fileName: string;
  parseState: ParseState;
  parseSecs: number;
  error: string;
  onPick: () => void;
  onFile: (file: File) => void;
  onContinue: () => void;
  onNoResume: () => void;
}) {
  return (
    <div className="flex flex-col gap-7">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-3)]">
          Profile
        </p>
        <h1 className="mt-4 text-[44px] leading-[1.05] tracking-[-0.02em] text-[var(--ink)]">
          Upload your{" "}
          <span className="font-serif italic text-[var(--ink-2)]">resume</span>
        </h1>
        <p className="mt-3 max-w-[36ch] text-[15px] leading-[1.55] text-[var(--ink-2)]">
          We&apos;ll read your skills, education and projects, then quietly look
          for rounds that fit.
        </p>
      </div>

      {/* Ruled paper dropzone */}
      <Button
        variant="outline"
        size="auto"
        onClick={onPick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className="group relative block w-full rounded-[10px] bg-[var(--paper-2)] px-6 py-10 text-left hover:bg-[var(--paper-2)]/80"
      >
        <span className="font-mono absolute left-4 top-3 text-[9px] uppercase tracking-[0.3em] text-[var(--ink-4)]">
          drop · click
        </span>
        <div className="flex flex-col items-center gap-3 pt-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--rule-strong)] transition-transform group-hover:-translate-y-0.5">
            <ArrowUpRight
              size={18}
              strokeWidth={1.5}
              className="rotate-[-45deg]"
            />
          </span>
          <p className="font-serif text-[20px] italic leading-none text-[var(--ink)]">
            tap to upload
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--ink-3)]">
            pdf · docx · 5 mb
          </p>
        </div>
      </Button>

      <Input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />

      {fileName && (
        <div className="anim-in flex items-center gap-4 rounded-[10px] border border-[var(--rule)] bg-[var(--paper-2)] px-4 py-3">
          {/* paper-clip mark */}
          <span className="font-serif text-[24px] italic text-[var(--ink-3)] leading-none">
            ¶
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-[var(--ink)]">{fileName}</p>
            <p className="font-mono mt-0.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink-3)]">
              {parseState === "parsing" && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="anim-pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                  reading
                </span>
              )}
              {parseState === "done" && `extracted · ${parseSecs}s`}
              {parseState === "error" && (
                <span className="text-[var(--accent)]">
                  {error || "couldn't parse"}
                </span>
              )}
            </p>
          </div>
          {parseState === "parsing" && (
            <Loader2
              size={16}
              strokeWidth={1.5}
              className="animate-spin text-[var(--ink-3)]"
            />
          )}
          {parseState === "done" && (
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--ink)]">
              <Check size={11} strokeWidth={2} />
            </span>
          )}
        </div>
      )}

      <div className="flex justify-center pt-2">
        <Button
          variant="link"
          size="auto"
          onClick={onNoResume}
          className="draw-underline font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--ink-2)]"
        >
          I don&apos;t have a resume yet
        </Button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 2 — profile review / manual entry
// -----------------------------------------------------------------------------

function ProfileStep({
  mode,
  profile,
  parseSecs,
  setProfile,
}: {
  mode: Mode;
  profile: OnboardingProfile;
  parseSecs: number;
  setProfile: React.Dispatch<React.SetStateAction<OnboardingProfile>>;
}) {
  const dashed = mode === "manual";

  return (
    <div className="flex flex-col gap-5">
      {mode === "parsed" ? (
        <aside className="relative rounded-[10px] border border-[var(--rule)] bg-[var(--paper-2)] py-4 pl-5 pr-4">
          <span className="absolute left-0 top-3 bottom-3 w-[3px] bg-[var(--accent)]" />
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-3)]">
            extracted · {parseSecs}s
          </p>
          <p className="mt-1.5 font-serif text-[18px] italic leading-snug text-[var(--ink)]">
            We pulled this from your résumé.
          </p>
          <p className="mt-0.5 text-[13px] text-[var(--ink-2)]">
            Edit anything that&apos;s off.
          </p>
        </aside>
      ) : (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-3)]">
            no résumé? no problem
          </p>
          <h1 className="mt-4 text-[40px] leading-[1.05] tracking-[-0.02em] text-[var(--ink)]">
            Tell us about{" "}
            <span className="font-serif italic text-[var(--ink-2)]">
              yourself
            </span>
            <span className="text-[var(--accent)]">.</span>
          </h1>
          <p className="mt-3 max-w-[36ch] text-[15px] leading-[1.55] text-[var(--ink-2)]">
            ~2 minutes. Anything you skip you can add later.
          </p>
        </div>
      )}

      <Section label="Name" dashed={dashed}>
        <Input
          value={profile.name}
          placeholder="How should we call you?"
          onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
        />
      </Section>

      <Section label="Education" dashed={dashed}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Input
            value={profile.education.degree}
            placeholder="Degree"
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                education: { ...p.education, degree: e.target.value },
              }))
            }
          />
          <Input
            value={profile.education.major}
            placeholder="Major"
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                education: { ...p.education, major: e.target.value },
              }))
            }
          />
          <div className="col-span-2">
            <Input
              value={profile.education.institution}
              placeholder="College / university"
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  education: { ...p.education, institution: e.target.value },
                }))
              }
            />
          </div>
          <Input
            value={profile.education.years}
            placeholder="Years (e.g. 2023–27)"
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                education: { ...p.education, years: e.target.value },
              }))
            }
          />
          <Input
            value={profile.education.standing}
            placeholder="Standing (3rd year)"
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                education: { ...p.education, standing: e.target.value },
              }))
            }
          />
        </div>
      </Section>

      <Section label="Skills · tools · languages" dashed={dashed}>
        <ChipEditor
          items={profile.skills}
          onChange={(skills) => setProfile((p) => ({ ...p, skills }))}
        />
      </Section>

      <Section label="Projects & experience" dashed={dashed}>
        <ListEditor
          items={profile.experience}
          onChange={(experience) => setProfile((p) => ({ ...p, experience }))}
        />
      </Section>

      <Section label="Scores" dashed={dashed}>
        <div className="grid grid-cols-3 gap-x-4">
          <LabeledField label="CGPA">
            <Input
              value={profile.scores.cgpa}
              placeholder="—"
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  scores: { ...p.scores, cgpa: e.target.value },
                }))
              }
            />
          </LabeledField>
          <LabeledField label="12th %">
            <Input
              value={profile.scores.twelfth}
              placeholder="—"
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  scores: { ...p.scores, twelfth: e.target.value },
                }))
              }
            />
          </LabeledField>
          <LabeledField label="10th %">
            <Input
              value={profile.scores.tenth}
              placeholder="—"
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  scores: { ...p.scores, tenth: e.target.value },
                }))
              }
            />
          </LabeledField>
        </div>
      </Section>
    </div>
  );
}

function Section({
  label,
  dashed,
  children,
}: {
  label: string;
  dashed: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={
        dashed
          ? "border-dashed border-[var(--rule-strong)] bg-transparent p-5"
          : "p-5"
      }
    >
      <div className="mb-3 flex items-baseline justify-between border-b border-[var(--rule-soft)] pb-2">
        <Label className="text-[var(--ink-3)]">{label}</Label>
      </div>
      {children}
    </Card>
  );
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-4)]">
        {label}
      </span>
      {children}
    </div>
  );
}

function ChipEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (!items.some((s) => s.toLowerCase() === name.toLowerCase()))
      onChange([...items, name]);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <Badge key={item} variant="default">
          {item}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`remove ${item}`}
            onClick={() => onChange(items.filter((s) => s !== item))}
            className="h-3.5 w-3.5 text-[var(--paper-2)] opacity-70 hover:bg-transparent hover:text-[var(--paper-2)] hover:opacity-100"
          >
            <X size={11} strokeWidth={2} />
          </Button>
        </Badge>
      ))}
      <Input
        value={draft}
        placeholder={items.length === 0 ? "tap to add" : "+ add"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        className="font-mono min-w-[88px] flex-1 border-dashed border-[var(--rule-strong)] px-1 py-1 text-[11px] uppercase tracking-[0.16em] focus:border-[var(--ink)]"
      />
    </div>
  );
}

function ListEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {items.map((item, i) => (
        <div
          key={i}
          className="group flex items-center gap-2 border-b border-[var(--rule-soft)] py-1.5"
        >
          <span className="font-mono w-5 text-[10px] text-[var(--ink-4)]">
            {String(i + 1).padStart(2, "0")}
          </span>
          <Input
            value={item}
            placeholder="Project, internship, club, certification…"
            onChange={(e) =>
              onChange(items.map((v, j) => (j === i ? e.target.value : v)))
            }
            className="flex-1 border-0 py-1 text-[14px]"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="remove"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            <X size={13} strokeWidth={1.5} className="text-[var(--ink-3)]" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="auto"
        onClick={() => onChange([...items, ""])}
        className="font-mono mt-2 w-fit gap-1.5 text-[10px] uppercase tracking-[0.22em]"
      >
        <Plus size={11} strokeWidth={1.5} /> add entry
      </Button>
    </div>
  );
}

function BottomBar({
  disabled,
  label,
  onClick,
}: {
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10">
      <div className="mx-auto max-w-[460px] px-6 pb-6 pt-4">
        <div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-b from-transparent to-[var(--paper)]" />
        <Button
          variant="default"
          size="lg"
          disabled={disabled}
          onClick={onClick}
          className="group relative w-full gap-1 rounded-[8px]"
        >
          <span className="font-body">{label}</span>
          <ArrowUpRight
            size={16}
            strokeWidth={1.5}
            className="ml-1 -translate-y-px text-[var(--accent)] transition-transform duration-200 group-hover:translate-x-0.5"
          />
        </Button>
      </div>
    </div>
  );
}
