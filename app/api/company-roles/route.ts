import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyName = url.searchParams.get("companyName")?.trim();

  if (!companyName) {
    return NextResponse.json({ roles: [] });
  }

  const company = await prisma.company.findUnique({
    where: { name: companyName },
    include: {
      sourceJobs: {
        include: { roleProfile: true },
        orderBy: { jobTitle: "asc" },
        take: 100,
      },
    },
  });

  if (!company) {
    return NextResponse.json({ roles: [] });
  }

  const seen = new Set<string>();
  const roles = company.sourceJobs
    .filter((job) => {
      const key = `${job.jobTitle}:${job.roleProfile.seniority}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((job) => ({
      jobTitle: job.jobTitle,
      role_slug: job.roleProfile.roleSlug,
      role_name: job.roleProfile.roleName,
      seniority: job.roleProfile.seniority,
      experience_min_years: job.experienceMinYears,
      experience_max_years: job.experienceMaxYears,
    }));

  return NextResponse.json({ roles });
}
