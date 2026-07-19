import mongoose from "mongoose";
import { env } from "./config/env.js";
import { ensureDemoAccount } from "./utils/demo-account.js";

if (!env.mongo) throw new Error("MONGODB_URI is required");
await mongoose.connect(env.mongo);
try {
  const configured = await ensureDemoAccount();
  console.log(configured ? `Demo account ready: ${env.demoEmail}` : "Demo account variables are not configured.");
} finally { await mongoose.disconnect(); }
