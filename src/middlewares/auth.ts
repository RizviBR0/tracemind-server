import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../modules/models.js";

export type AuthRequest = Request & { user?: { id: string; role: string } };

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token || !env.jwt) return res.status(401).json({ message: "Authentication required" });
  try {
    const decoded = jwt.verify(token, env.jwt) as { id: string };
    const user = await User.findById(decoded.id).select("role status");
    if (!user || user.status === "suspended") return res.status(401).json({ message: "Session is no longer valid" });
    req.user = { id: user.id, role: user.role };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired session" });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ message: "Administrator access required" });
  next();
}
