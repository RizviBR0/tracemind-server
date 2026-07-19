import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { User } from "../modules/models.js";

export async function ensureDemoAccount() {
  if (!env.demoEmail || !env.demoPassword) return false;
  if (env.demoPassword.length < 8) throw new Error("DEMO_PASSWORD must contain at least 8 characters");

  const existing = await User.findOne({ email: env.demoEmail });
  if (!existing) {
    await User.create({
      name: "Demo User",
      email: env.demoEmail,
      password: await bcrypt.hash(env.demoPassword, 12),
      role: "user",
      status: "active",
    });
    return true;
  }

  const passwordMatches = await bcrypt.compare(env.demoPassword, existing.password);
  existing.name = "Demo User";
  existing.role = "user";
  existing.status = "active";
  if (!passwordMatches) existing.password = await bcrypt.hash(env.demoPassword, 12);
  if (existing.isModified()) await existing.save();
  return true;
}
