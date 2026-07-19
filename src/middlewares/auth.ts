import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../modules/models.js";

export type AuthRequest = Request & { user?: { id: string; role: string } };

function readToken(req: AuthRequest) {
  return req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
}

async function loadUser(req: AuthRequest, token: string) {
  const decoded = jwt.verify(token, env.jwt) as { id: string };
  const user = await User.findById(decoded.id).select("role status");
  if (!user || user.status === "suspended") return null;
  req.user = { id: user.id, role: user.role };
  return user;
}

export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token || !env.jwt) return next();
  try {
    await loadUser(req, token);
  } catch {
    // An anonymous or expired session is a valid state for /auth/me.
  }
  next();
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token || !env.jwt) return res.status(401).json({ message: "Authentication required" });
  try {
    const user = await loadUser(req, token);
    if (!user) return res.status(401).json({ message: "Session is no longer valid" });
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired session" });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ message: "Administrator access required" });
  next();
}
