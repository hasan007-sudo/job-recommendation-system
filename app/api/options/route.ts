import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";

export async function GET() {
  const [companies, roles, skills] = await Promise.all([
    prisma.company.findMany({ orderBy: { name: "asc" } }),
    prisma.roleProfile.findMany({ orderBy: [{ roleName: "asc" }, { seniority: "asc" }] }),
    prisma.skill.findMany({ orderBy: { name: "asc" } }),
  ]);

  return NextResponse.json({
    companies,
    roles: roles.map((role) => ({
      id: role.id,
      role_slug: role.roleSlug,
      role_name: role.roleName,
      seniority: role.seniority,
    })),
    skills,
  });
}
