"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  FileText,
  Loader2,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "../../components/shadcn/badge";
import { Button } from "../../components/shadcn/button";
import {
  Card as ShadcnCard,
  CardContent,
} from "../../components/shadcn/card";
import { Input } from "../../components/shadcn/input";
import {
  deriveSearchInput,
  EMPTY_PROFILE,
  type OnboardingProfile,
} from "../../lib/onboarding";
import { postForm } from "../../lib/api";

type Step = "upload" | "profile";
type ParseState = "idle" | "parsing" | "done" | "error";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [profile, setProfile] = useState<OnboardingProfile>(EMPTY_PROFILE);
  const [fileName, setFileName] = useState("");
  const [parseState, setParseState] = useState<ParseState>("idle");
  const [parseSecs, setParseSecs] = useState(0);
  const [error, setError] = useState("");

  const parseMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return postForm<{ profile: OnboardingProfile }>(
        "/api/onboarding/parse",
        fd,
      );
    },
    onMutate: (file) => {
      setFileName(file.name);
      setParseState("parsing");
      setError("");
      return { started: Date.now() };
    },
    onSuccess: (data, _file, ctx) => {
      setProfile(data.profile);
      setParseSecs(
        Math.max(1, Math.round((Date.now() - (ctx?.started ?? Date.now())) / 1000)),
      );
      setParseState("done");
      setStep("profile");
    },
    onError: (e) => {
      setParseState("error");
      setError(e instanceof Error ? e.message : "Could not parse this résumé.");
    },
  });

  function handleFile(file: File) {
    parseMutation.mutate(file);
  }

  function confirmAndContinue() {
    sessionStorage.setItem(
      "rounds:autosearch",
      JSON.stringify(deriveSearchInput(profile)),
    );
    sessionStorage.setItem("rounds:profile", JSON.stringify(profile));
    router.push("/");
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-slate-900" />
            <span className="text-md font-bold tracking-tight text-slate-900">
              Rounds
            </span>
          </div>
          <span className="text-xs font-bold uppercase tracking-[0.22em] text-slate-500">
            {step === "upload"
              ? "Step 01 / Onboarding"
              : "Step 02 / Profile review"}
          </span>
        </div>
      </header>

      {step === "upload" ? (
        <UploadStep
          fileName={fileName}
          parseState={parseState}
          parseSecs={parseSecs}
          error={error}
          onFile={handleFile}
          onManual={() => {
            setProfile(EMPTY_PROFILE);
            setStep("profile");
          }}
        />
      ) : (
        <ProfileStep
          profile={profile}
          setProfile={setProfile}
          onConfirm={confirmAndContinue}
        />
      )}
    </main>
  );
}

function UploadStep({
  fileName,
  parseState,
  parseSecs,
  error,
  onFile,
  onManual,
}: {
  fileName: string;
  parseState: ParseState;
  parseSecs: number;
  error: string;
  onFile: (file: File) => void;
  onManual: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-bold leading-[1.05] tracking-tight text-slate-900">
        Know every interview before you walk in.
      </h1>
      <p className="mt-4 max-w-xl text-md leading-[1.6] text-slate-500">
        Drop your resume and we&apos;ll show you which roles fit, the rounds
        you&apos;ll face, and the competencies interviewers actually assess.
      </p>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className="mt-10 cursor-pointer rounded-2xl border-2 border-dashed border-slate-300 bg-white px-6 py-14 text-center transition hover:border-indigo-500 hover:bg-indigo-50/50"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-500">
          <Upload size={20} strokeWidth={2} />
        </div>
        <p className="mt-4 text-base font-semibold text-slate-900">
          Drop your resume here, or{" "}
          <span className="text-indigo-600 underline-offset-2 hover:underline">
            browse
          </span>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          PDF, DOCX, or TXT — up to 10MB
        </p>
        <span className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white">
          Select file
        </span>
      </div>

      <Input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />

      {fileName && (
        <div className="mt-6 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <FileText size={18} className="text-slate-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900">
              {fileName}
            </p>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
              {parseState === "parsing" && "reading…"}
              {parseState === "done" && `extracted · ${parseSecs}s`}
              {parseState === "error" && (error || "couldn't parse")}
            </p>
          </div>
          {parseState === "parsing" && (
            <Loader2 size={16} className="animate-spin text-slate-500" />
          )}
          {parseState === "done" && (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white">
              <Check size={12} strokeWidth={3} />
            </span>
          )}
        </div>
      )}

      <div className="mt-8 text-center">
        <Button
          variant="link"
          size="auto"
          onClick={onManual}
          className="text-sm font-semibold text-indigo-600 hover:underline"
        >
          Enter details manually →
        </Button>
      </div>

      <div className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Pitch label="FIT" body="Resume × Role match in seconds" />
        <Pitch label="ROUNDS" body="Every stage, in order" />
        <Pitch label="FOCUS" body="What interviewers actually assess" />
      </div>
    </div>
  );
}

function Pitch({ label, body }: { label: string; body: string }) {
  return (
    <ShadcnCard className="rounded-xl border-slate-200 bg-white">
      <CardContent className="p-4">
      <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-600">
        {label}
      </p>
      <p className="mt-2 text-sm text-slate-800">{body}</p>
      </CardContent>
    </ShadcnCard>
  );
}

function ProfileStep({
  profile,
  setProfile,
  onConfirm,
}: {
  profile: OnboardingProfile;
  setProfile: React.Dispatch<React.SetStateAction<OnboardingProfile>>;
  onConfirm: () => void;
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-start justify-between gap-6">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-bold leading-[1.05] tracking-tight text-slate-900">
            Here&apos;s what we read from your resume.
          </h1>
          <p className="mt-3 text-md leading-[1.6] text-slate-500">
            Fix anything that looks off, then continue to start matching against
            live roles.
          </p>
        </div>
        <Button
          onClick={onConfirm}
          size="lg"
          className="shrink-0 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white"
        >
          Confirm &amp; continue <ArrowRight size={16} />
        </Button>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="Identity">
          <FieldRow label="Full name">
            <UnderlineInput
              value={profile.name}
              placeholder="How should we call you?"
              onChange={(v) => setProfile((p) => ({ ...p, name: v }))}
            />
          </FieldRow>
        </Card>

        <Card title="Experience">
          <FieldRow label="Years of experience">
            <div className="flex items-center gap-3">
              <NumberInput
                value={profile.experienceMinYears}
                placeholder="Min"
                onChange={(v) =>
                  setProfile((p) => ({ ...p, experienceMinYears: v }))
                }
              />
              <span className="text-md text-slate-400">–</span>
              <NumberInput
                value={profile.experienceMaxYears}
                placeholder="Max"
                onChange={(v) =>
                  setProfile((p) => ({ ...p, experienceMaxYears: v }))
                }
              />
            </div>
          </FieldRow>
        </Card>

        <Card title="Education">
          <div className="grid grid-cols-2 gap-x-5 gap-y-5">
            <FieldRow label="Degree">
              <UnderlineInput
                value={profile.education.degree}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    education: { ...p.education, degree: v },
                  }))
                }
              />
            </FieldRow>
            <FieldRow label="Major">
              <UnderlineInput
                value={profile.education.major}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    education: { ...p.education, major: v },
                  }))
                }
              />
            </FieldRow>
            <FieldRow label="Institution">
              <UnderlineInput
                value={profile.education.institution}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    education: { ...p.education, institution: v },
                  }))
                }
              />
            </FieldRow>
            <FieldRow label="Year">
              <UnderlineInput
                value={profile.education.years}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    education: { ...p.education, years: v },
                  }))
                }
              />
            </FieldRow>
            <FieldRow label="Standing">
              <UnderlineInput
                value={profile.education.standing}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    education: { ...p.education, standing: v },
                  }))
                }
              />
            </FieldRow>
          </div>
        </Card>

        <Card title="Academic scores">
          <div className="grid grid-cols-3 gap-5">
            <FieldRow label="CGPA">
              <UnderlineInput
                value={profile.scores.cgpa}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    scores: { ...p.scores, cgpa: v },
                  }))
                }
                big
              />
            </FieldRow>
            <FieldRow label="12th %">
              <UnderlineInput
                value={profile.scores.twelfth}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    scores: { ...p.scores, twelfth: v },
                  }))
                }
                big
              />
            </FieldRow>
            <FieldRow label="10th %">
              <UnderlineInput
                value={profile.scores.tenth}
                placeholder="—"
                onChange={(v) =>
                  setProfile((p) => ({
                    ...p,
                    scores: { ...p.scores, tenth: v },
                  }))
                }
                big
              />
            </FieldRow>
          </div>
        </Card>

        <Card title="Skills" hint={`${profile.skills.length} extracted`}>
          <SkillsEditor
            items={profile.skills}
            onChange={(skills) => setProfile((p) => ({ ...p, skills }))}
          />
        </Card>

        <div className="lg:col-span-2">
          <Card title="Experience" hint={`${profile.experience.length} roles`}>
            <ExperienceEditor
              items={profile.experience}
              onChange={(experience) =>
                setProfile((p) => ({ ...p, experience }))
              }
              placeholder="Role at company…"
            />
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card title="Projects" hint={`${profile.projects.length} projects`}>
            <ExperienceEditor
              items={profile.projects}
              onChange={(projects) =>
                setProfile((p) => ({ ...p, projects }))
              }
              placeholder="Side, academic, or open-source project…"
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <ShadcnCard className="rounded-2xl border-slate-200 bg-white">
      <CardContent className="p-6">
        <div className="mb-5 flex items-center justify-between border-b border-slate-200 pb-3">
          <h2 className="text-xs font-bold uppercase tracking-[0.22em] text-slate-500">
            {title}
          </h2>
          {hint && (
            <span className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
              {hint}
            </span>
          )}
        </div>
        {children}
      </CardContent>
    </ShadcnCard>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-bold uppercase tracking-[0.22em] text-slate-500">
        {label}
      </div>
      {children}
    </div>
  );
}

function UnderlineInput({
  value,
  placeholder,
  onChange,
  big,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  big?: boolean;
}) {
  return (
    <Input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={
        "block w-full border-0 border-b border-slate-200 bg-transparent pb-1.5 outline-none focus:border-indigo-500 " +
        (big ? "text-xl font-bold" : "text-md font-semibold")
      }
    />
  );
}

function NumberInput({
  value,
  placeholder,
  onChange,
}: {
  value: number;
  placeholder?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Input
      type="number"
      min={0}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
      className="block w-full border-0 border-b border-slate-200 bg-transparent pb-1.5 text-md font-semibold outline-none focus:border-indigo-500"
    />
  );
}

function SkillsEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v) return;
    if (!items.some((s) => s.toLowerCase() === v.toLowerCase()))
      onChange([...items, v]);
    setDraft("");
  }
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <Badge
            key={s}
            variant="outline"
            className="rounded-md border-0 bg-slate-100 px-2.5 py-1 text-xs text-slate-800"
          >
            {s}
            <Button
              variant="ghost"
              size="auto"
              aria-label={`remove ${s}`}
              onClick={() => onChange(items.filter((x) => x !== s))}
              className="border-0 text-slate-500 hover:text-slate-900"
            >
              <X size={11} strokeWidth={2.5} />
            </Button>
          </Badge>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a skill (e.g. Kubernetes)"
          className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm placeholder:text-slate-400 focus:border-indigo-500"
        />
        <Button
          onClick={add}
          variant="outline"
          className="rounded-lg border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-900 hover:bg-slate-100"
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function ExperienceEditor({
  items,
  onChange,
  placeholder,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="divide-y divide-slate-200">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <span className="w-6 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
            {String(i + 1).padStart(2, "0")}
          </span>
          <Input
            value={item}
            placeholder={placeholder}
            onChange={(e) =>
              onChange(items.map((v, j) => (j === i ? e.target.value : v)))
            }
            className="flex-1 border-0 bg-transparent text-sm font-medium"
          />
          <Button
            variant="ghost"
            size="auto"
            aria-label="remove"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="border-0 text-slate-400 hover:text-slate-900"
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button
        variant="link"
        size="auto"
        onClick={() => onChange([...items, ""])}
        className="pt-4 text-xs font-bold uppercase tracking-[0.18em] text-indigo-600"
      >
        <Plus size={12} strokeWidth={2.5} /> Add entry
      </Button>
    </div>
  );
}
