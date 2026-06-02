// Client-side wrapper around POST /api/match. Kept separate from lib/match.ts
// (which imports prisma and is server-only).

export async function requestMatchScores(
  resumeText: string,
  jobIds: string[],
): Promise<Record<string, number>> {
  if (!resumeText.trim() || jobIds.length === 0) return {};
  try {
    const res = await fetch("/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeText, jobIds }),
    });
    const data = await res.json();
    return (data.scores ?? {}) as Record<string, number>;
  } catch {
    return {};
  }
}
