import type { VercelRequest, VercelResponse } from "@vercel/node";
import mongoose from "mongoose";
import app from "../src/app.js";
import { env } from "../src/config/env.js";
import { Case } from "../src/modules/models.js";
import { ensureDemoAccount } from "../src/utils/demo-account.js";

let initialization: Promise<void> | undefined;

async function initialize() {
  if (!env.mongo) throw new Error("MONGODB_URI is required");
  if (!env.jwt || env.jwt.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

  if (mongoose.connection.readyState !== 1) await mongoose.connect(env.mongo);
  await Case.updateMany({ visibility: "private", status: "Under review" }, { $set: { status: "Draft" } });
  await ensureDemoAccount();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  initialization ??= initialize().catch(error => {
    initialization = undefined;
    throw error;
  });
  await initialization;
  return app(req, res);
}
