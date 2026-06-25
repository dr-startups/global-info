/**
 * Digital Profile user service (Stage M1). Node-only (Prisma + scrypt).
 */

import { prisma } from "@/server/prisma/client";
import type { DpRole } from "./roles";
import { hashPassword, verifyPassword } from "./password";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: DpRole;
  isActive: boolean;
}

function toAuthUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as DpRole,
    isActive: u.isActive,
  };
}

export async function findUserById(id: string): Promise<AuthUser | null> {
  const u = await prisma.dpUser.findUnique({ where: { id } });
  return u ? toAuthUser(u) : null;
}

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const u = await prisma.dpUser.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  return u ? toAuthUser(u) : null;
}

export async function listUsers(): Promise<AuthUser[]> {
  const users = await prisma.dpUser.findMany({ orderBy: { createdAt: "asc" } });
  return users.map(toAuthUser);
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: DpRole;
  password: string;
  isActive?: boolean;
}

/** Creates (or updates password/role of) a user. Used by seed + admin tools. */
export async function upsertUser(input: CreateUserInput): Promise<AuthUser> {
  const email = input.email.toLowerCase().trim();
  const passwordHash = await hashPassword(input.password);
  const u = await prisma.dpUser.upsert({
    where: { email },
    create: {
      email,
      name: input.name,
      role: input.role,
      passwordHash,
      isActive: input.isActive ?? true,
    },
    update: {
      name: input.name,
      role: input.role,
      passwordHash,
      isActive: input.isActive ?? true,
    },
  });
  return toAuthUser(u);
}

/**
 * Validates credentials. Returns the user on success, null on any failure
 * (unknown email, inactive, wrong password). Generic failure — no detail leak.
 */
export async function authenticate(
  email: string,
  password: string
): Promise<AuthUser | null> {
  const u = await prisma.dpUser.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  if (!u || !u.isActive) {
    // Still run a hash to reduce timing oracle on user existence.
    await verifyPassword(password, "scrypt$16384$8$1$AAAA$AAAA");
    return null;
  }
  const ok = await verifyPassword(password, u.passwordHash);
  if (!ok) return null;
  await prisma.dpUser.update({
    where: { id: u.id },
    data: { lastLoginAt: new Date() },
  });
  return toAuthUser(u);
}
