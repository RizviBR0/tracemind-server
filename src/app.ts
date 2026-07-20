import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "./config/env.js";
import { AIMessage, Case, DecisionSession, Document, Report, Review, SavedCase, User } from "./modules/models.js";
import { AuthRequest, optionalAuth, requireAdmin, requireAuth } from "./middlewares/auth.js";
import { buildDecision } from "./utils/ai.js";
import { analyzeDocument } from "./utils/document-ai.js";
import { aiKeyStorageConfigured, encryptUserAiKey, keyHint } from "./utils/user-ai-key.js";

const app = express();
app.use((helmet as unknown as () => express.RequestHandler)());
app.use(cors({ origin: env.client, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use((rateLimit as unknown as (options: Record<string, unknown>) => express.RequestHandler)({ windowMs: 15 * 60 * 1000, limit: 150 }));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:5},fileFilter:(_r,f,cb)=>cb(null,["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","text/plain","image/png","image/jpeg"].includes(f.mimetype))}); const slugify=(v:string)=>v.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");
const approvedPublicFilter = { visibility: "public", status: "Approved" } as const;

function relatedCaseScore(current: any, candidate: any) {
  const normalize = (values: unknown[] = []) => new Set(values.map(value => String(value).toLowerCase().trim()).filter(Boolean));
  const currentTags = normalize(current.tags);
  const candidateTags = normalize(candidate.tags);
  const words = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3));
  const currentWords = words(`${current.title} ${current.shortDescription}`);
  const candidateWords = words(`${candidate.title} ${candidate.shortDescription}`);
  let score = current.category === candidate.category ? 8 : 0;
  candidateTags.forEach(tag => { if (currentTags.has(tag)) score += 4; });
  candidateWords.forEach(word => { if (currentWords.has(word)) score += 1; });
  return score;
}

async function deleteCaseDependents(caseId: string) {
  const sessions = await DecisionSession.find({ caseId }).select("_id").lean();
  const sessionIds = sessions.map(session => session._id);
  await Promise.all([
    Document.deleteMany({ caseId }),
    Review.deleteMany({ caseId }),
    SavedCase.deleteMany({ caseId }),
    Report.deleteMany({ caseId }),
    DecisionSession.deleteMany({ caseId }),
    AIMessage.deleteMany({ sessionId: { $in: sessionIds } }),
  ]);
}
app.get("/health",(_q,r)=>r.json({status:"ok"}));
const productionCookies = process.env.NODE_ENV === "production";
const cookieSameSite: "none" | "lax" = productionCookies ? "none" : "lax";
const cookieOptions = { httpOnly: true, sameSite: cookieSameSite, secure: productionCookies, maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" };
const googleCallbackUrl = `${env.client.replace(/\/$/, "")}/api/backend/api/auth/google/callback`;
const publicUser = (user: any) => ({ id: user.id, name: user.name, email: user.email, role: user.role });
const issueSession = (res: express.Response, user: any) => {
  const token = jwt.sign({ id: user.id, role: user.role }, env.jwt, { expiresIn: "7d" });
  res.cookie("token", token, cookieOptions);
};

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().trim().min(2).max(80), email: z.email().transform(email => email.trim().toLowerCase()), password: z.string().min(8).max(128) }).parse(req.body);
    if (await User.exists({ email: input.email })) return res.status(409).json({ code: "EMAIL_ALREADY_REGISTERED", message: "This email is already registered. Log in instead." });
    const user = await User.create({ ...input, password: await bcrypt.hash(input.password, 12) });
    issueSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (error: any) {
    if (error?.code === 11000 && error?.keyPattern?.email) return res.status(409).json({ code: "EMAIL_ALREADY_REGISTERED", message: "This email is already registered. Log in instead." });
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const input = z.object({ email: z.email(), password: z.string().min(1).max(128) }).parse(req.body);
    const user = await User.findOne({ email: input.email });
    if (!user || !(await bcrypt.compare(input.password, user.password))) return res.status(401).json({ message: "Invalid email or password" });
    if (user.status === "suspended") return res.status(403).json({ message: "This account has been suspended" });
    issueSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.get("/api/auth/me", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    if (!req.user) return res.json({ user: null });
    const user = await User.findById(req.user!.id);
    if (!user || user.status === "suspended") return res.json({ user: null });
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.patch("/api/auth/profile", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
    const user = await User.findByIdAndUpdate(req.user!.id, { name: input.name }, { new: true });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.get("/api/auth/ai-key", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await User.findById(req.user!.id).select("+aiKeyEncrypted +aiKeyHint");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ configured: Boolean(user.aiKeyEncrypted), keyHint: user.aiKeyHint || null, storageAvailable: aiKeyStorageConfigured() });
  } catch (error) { next(error); }
});

app.put("/api/auth/ai-key", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (!aiKeyStorageConfigured()) return res.status(503).json({ message: "Personal AI key storage is unavailable. Contact the site administrator." });
    const input = z.object({ apiKey: z.string().trim().min(20).max(300) }).parse(req.body);
    const apiKey = input.apiKey;
    if (!/^[A-Za-z0-9._-]+$/.test(apiKey)) return res.status(400).json({ message: "Enter only a valid API key" });
    const user = await User.findByIdAndUpdate(req.user!.id, { aiKeyEncrypted: encryptUserAiKey(apiKey), aiKeyHint: keyHint(apiKey) }, { new: true }).select("+aiKeyHint");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ configured: true, keyHint: user.aiKeyHint });
  } catch (error) { next(error); }
});

app.delete("/api/auth/ai-key", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(req.user!.id, { $unset: { aiKeyEncrypted: 1, aiKeyHint: 1 } }, { new: true });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ configured: false, keyHint: null });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("token", { httpOnly: true, sameSite: cookieSameSite, secure: productionCookies, path: "/" });
  res.status(204).end();
});

app.get("/api/auth/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).json({ message: "Google OAuth is not configured" });
  const state = jwt.sign({ purpose: "google-oauth" }, env.jwt, { expiresIn: "10m" });
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: googleCallbackUrl, response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/api/auth/google/callback", async (req, res, next) => {
  try {
    const code = z.string().parse(req.query.code);
    const state = z.string().parse(req.query.state);
    const decoded = jwt.verify(state, env.jwt) as { purpose?: string };
    if (decoded.purpose !== "google-oauth") return res.status(400).json({ message: "Invalid OAuth state" });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: googleCallbackUrl, grant_type: "authorization_code" }) });
    if (!tokenResponse.ok) return res.status(401).json({ message: "Google authentication failed" });
    const tokens = await tokenResponse.json() as { access_token: string };
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!profileResponse.ok) return res.status(401).json({ message: "Unable to read Google profile" });
    const profile = await profileResponse.json() as { email: string; name?: string };
    const existing = await User.findOne({ email: profile.email });
    const user = existing || await User.create({ name: profile.name || profile.email.split("@")[0], email: profile.email, password: await bcrypt.hash(randomBytes(32).toString("hex"), 12), role: "user" });
    issueSession(res, user);
    res.redirect(`${env.client}/workspace`);
  } catch (error) { next(error); }
});
app.get("/api/v1/cases",async(req,res,next)=>{try{const {q,category,priority,sort="newest",page="1"}=req.query;const filter:any={...approvedPublicFilter};if(q)filter.$text={$search:String(q)};if(category)filter.category=category;if(priority)filter.priority=priority;const ordering:any={newest:{createdAt:-1},oldest:{createdAt:1},rating:{averageRating:-1},views:{viewCount:-1}}[String(sort)]||{createdAt:-1};const limit=12,skip=(Number(page)-1)*limit;const [items,total]=await Promise.all([Case.find(filter).populate("ownerId","name").sort(ordering).skip(skip).limit(limit).lean(),Case.countDocuments(filter)]);res.json({items,total,page:Number(page),pages:Math.ceil(total/limit)})}catch(e){next(e)}});
app.get("/api/v1/cases/mine",requireAuth,async(req:AuthRequest,res,next)=>{try{res.json(await Case.find({ownerId:req.user!.id}).sort({createdAt:-1}))}catch(e){next(e)}});
app.get("/api/v1/cases/:slug",async(req,res,next)=>{try{const item=await Case.findOne({slug:req.params.slug,...approvedPublicFilter}).populate("ownerId","name").lean();if(!item)return res.status(404).json({message:"Case not found"});await Case.updateOne({_id:item._id},{$inc:{viewCount:1}});const [candidates,reviews]=await Promise.all([Case.find({_id:{$ne:item._id},...approvedPublicFilter}).populate("ownerId","name").sort({averageRating:-1,createdAt:-1}).limit(60).lean(),Review.find({caseId:item._id}).populate("userId","name").sort({createdAt:-1}).limit(20).lean()]);const related=candidates.map(candidate=>({candidate,score:relatedCaseScore(item,candidate)})).filter(entry=>entry.score>0).sort((a,b)=>b.score-a.score||Number(b.candidate.averageRating||0)-Number(a.candidate.averageRating||0)||new Date(b.candidate.createdAt).getTime()-new Date(a.candidate.createdAt).getTime()).slice(0,4).map(entry=>entry.candidate);res.json({item:{...item,viewCount:(item.viewCount||0)+1},related,reviews})}catch(e){next(e)}});
app.post("/api/v1/cases",requireAuth,async(req:AuthRequest,res,next)=>{try{const p=z.object({title:z.string().min(5),shortDescription:z.string().min(20),fullDescription:z.string().min(50),category:z.string().min(2),priority:z.enum(["High","Medium","Low"]),targetDate:z.coerce.date().optional(),goals:z.array(z.string()).default([]),constraints:z.array(z.string()).default([]),tags:z.array(z.string()).default([]),visibility:z.enum(["public","private"]).default("private"),coverImage:z.string().url().optional()}).parse(req.body);const base=slugify(p.title);const status=p.visibility==="public"?"Under review":"Draft";const item=await Case.create({...p,status,ownerId:req.user!.id,slug:`${base}-${Date.now().toString().slice(-5)}`});res.status(201).json(item)}catch(e){next(e)}});
app.patch("/api/v1/cases/:id/publication",requireAuth,async(req:AuthRequest,res,next)=>{try{const p=z.object({visibility:z.enum(["public","private"])}).parse(req.body);const item=await Case.findOne({_id:req.params.id,ownerId:req.user!.id});if(!item)return res.status(404).json({message:"Case not found"});item.visibility=p.visibility;item.status=p.visibility==="public"?"Under review":"Draft";item.moderationNote=undefined;item.moderatedAt=undefined;item.moderatedBy=undefined;await item.save();res.json(item)}catch(e){next(e)}});
app.delete("/api/v1/cases/:id",requireAuth,async(req:AuthRequest,res,next)=>{try{const item=await Case.findOneAndDelete({_id:req.params.id,ownerId:req.user!.id});if(!item)return res.status(404).json({message:"Case not found"});await deleteCaseDependents(item.id);res.status(204).end()}catch(e){next(e)}});
app.get("/api/v1/cases/:slug/saved",requireAuth,async(req:AuthRequest,res,next)=>{try{const item=await Case.findOne({slug:req.params.slug,...approvedPublicFilter}).select("_id");if(!item)return res.status(404).json({message:"Case not found"});res.json({saved:!!(await SavedCase.exists({userId:req.user!.id,caseId:item.id}))})}catch(e){next(e)}});
app.post("/api/v1/cases/:slug/save",requireAuth,async(req:AuthRequest,res,next)=>{try{const item=await Case.findOne({slug:req.params.slug,...approvedPublicFilter}).select("_id");if(!item)return res.status(404).json({message:"Case not found"});const existing=await SavedCase.findOneAndDelete({userId:req.user!.id,caseId:item.id});if(existing)return res.json({saved:false});await SavedCase.create({userId:req.user!.id,caseId:item.id});res.status(201).json({saved:true})}catch(e){next(e)}});
app.post("/api/v1/cases/:slug/report",requireAuth,async(req:AuthRequest,res,next)=>{try{const item=await Case.findOne({slug:req.params.slug,...approvedPublicFilter}).select("_id");if(!item)return res.status(404).json({message:"Case not found"});const input=z.object({reason:z.string().min(5).max(500).default("Inappropriate or inaccurate public content")}).parse(req.body||{});await Report.findOneAndUpdate({userId:req.user!.id,caseId:item.id},{reason:input.reason,status:"open"},{upsert:true,new:true});res.status(201).json({reported:true})}catch(e){next(e)}});
app.get("/api/v1/cases/:id/reviews",async(req,res,next)=>{try{res.json(await Review.find({caseId:req.params.id}).sort({createdAt:-1}))}catch(e){next(e)}});
app.post("/api/v1/cases/:id/reviews",requireAuth,async(req:AuthRequest,res,next)=>{try{const p=z.object({rating:z.number().int().min(1).max(5),comment:z.string().min(5).max(1000)}).parse(req.body);const item=await Case.findOne({_id:req.params.id,...approvedPublicFilter});if(!item)return res.status(404).json({message:"Public case not found"});const review=await Review.findOneAndUpdate({caseId:item.id,userId:req.user!.id},p,{upsert:true,new:true,setDefaultsOnInsert:true});const agg=await Review.aggregate([{$match:{caseId:item._id}},{$group:{_id:null,avg:{$avg:"$rating"},count:{$sum:1}}}]);await Case.updateOne({_id:item.id},{$set:{averageRating:agg[0]?.avg||0,reviewCount:agg[0]?.count||0}});res.status(201).json(review)}catch(e){next(e)}});
app.post("/api/v1/documents/upload",requireAuth,upload.array("files",5),async(req:AuthRequest,res,next)=>{try{const caseId=z.string().parse(req.body.caseId);const item=await Case.findOne({_id:caseId,ownerId:req.user!.id});if(!item)return res.status(404).json({message:"Case not found"});const files=req.files as Express.Multer.File[];if(!files?.length)return res.status(400).json({message:"Provide at least one accepted file"});const records=await Document.insertMany(files.map(f=>({caseId,ownerId:req.user!.id,filename:f.originalname.replace(/[^a-zA-Z0-9._ -]/g,"_"),fileType:f.mimetype,size:f.size,content:f.buffer,processingStatus:"queued"})));res.status(201).json(records)}catch(e){next(e)}});
app.post("/api/v1/documents/:id/process",requireAuth,async(req:AuthRequest,res,next)=>{let doc;try{doc=await Document.findOne({_id:req.params.id,ownerId:req.user!.id}).select("+content");if(!doc)return res.status(404).json({message:"Document not found"});if(!doc.content)return res.status(422).json({message:"The uploaded document content is unavailable. Upload the file again."});doc.processingStatus="processing";doc.errorMessage=undefined;await doc.save();const result=await analyzeDocument(doc.filename||"document",doc.fileType||"application/octet-stream",doc.content,req.user!.id);doc.processingStatus="complete";doc.summary=result.summary;doc.keyPoints=result.keyPoints;doc.risks=result.risks;doc.actionItems=result.actionItems;doc.generatedTags=result.generatedTags;await doc.save();res.json(doc)}catch(e){if(doc){doc.processingStatus="failed";doc.errorMessage=e instanceof Error?e.message:"Document processing failed";await doc.save().catch(()=>undefined)}next(e)}});
app.get("/api/v1/documents/:id",requireAuth,async(req:AuthRequest,res,next)=>{try{const doc=await Document.findOne({_id:req.params.id,ownerId:req.user!.id});if(!doc)return res.status(404).json({message:"Document not found"});res.json(doc)}catch(e){next(e)}});
app.delete("/api/v1/documents/:id",requireAuth,async(req:AuthRequest,res,next)=>{try{const doc=await Document.findOneAndDelete({_id:req.params.id,ownerId:req.user!.id});if(!doc)return res.status(404).json({message:"Document not found"});res.status(204).end()}catch(e){next(e)}});
app.get("/api/v1/documents/:id/report",requireAuth,async(req:AuthRequest,res,next)=>{try{const doc=await Document.findOne({_id:req.params.id,ownerId:req.user!.id});if(!doc)return res.status(404).json({message:"Document not found"});res.type("text/plain").attachment(`${doc.filename}-summary.txt`).send(`TraceMind document summary\n\n${doc.summary}\n\nKey points:\n${(doc.keyPoints||[]).join("\n")}`)}catch(e){next(e)}});
app.post("/api/v1/ai/decisions",requireAuth,async(req:AuthRequest,res,next)=>{try{const p=z.object({caseId:z.string(),message:z.string().max(4000).optional()}).parse(req.body);const item=await Case.findOne({_id:p.caseId,ownerId:req.user!.id});if(!item)return res.status(404).json({message:"Case not found"});const result=await buildDecision(p.caseId,p.message||"");const session=await DecisionSession.create({caseId:p.caseId,userId:req.user!.id,title:item.title,recommendation:result.recommendedOption,confidence:result.confidence,alternatives:result.alternatives,risks:result.risks,assumptions:result.assumptions,actionItems:result.actionItems});if(p.message)await AIMessage.create({sessionId:session.id,userId:req.user!.id,role:"user",content:p.message});await AIMessage.create({sessionId:session.id,userId:req.user!.id,role:"assistant",content:result.explanation,toolCalls:["searchCaseKnowledge","retrieveRelatedDocuments","detectConflicts","scoreDecisionOptions","createActionItems","saveDecisionMemory"]});res.status(201).json({session,result})}catch(e){next(e)}});
app.post("/api/v1/ai/decisions/:id/message",requireAuth,async(req:AuthRequest,res,next)=>{try{const p=z.object({message:z.string().min(1).max(4000)}).parse(req.body);const session=await DecisionSession.findOne({_id:req.params.id,userId:req.user!.id});if(!session)return res.status(404).json({message:"Decision session not found"});const result=await buildDecision(String(session.caseId),p.message,String(session._id));session.recommendation=result.recommendedOption;session.confidence=result.confidence;session.alternatives=result.alternatives;session.risks=result.risks;session.assumptions=result.assumptions;session.actionItems=result.actionItems;session.status="active";await session.save();await AIMessage.create({sessionId:session.id,userId:req.user!.id,role:"user",content:p.message});const reply=await AIMessage.create({sessionId:session.id,userId:req.user!.id,role:"assistant",content:result.explanation,toolCalls:["searchCaseKnowledge","retrieveRelatedDocuments"]});res.json({message:reply,result})}catch(e){next(e)}});
app.get("/api/v1/ai/decisions/:id",requireAuth,async(req:AuthRequest,res,next)=>{try{const session=await DecisionSession.findOne({_id:req.params.id,userId:req.user!.id});if(!session)return res.status(404).json({message:"Decision session not found"});res.json({session,messages:await AIMessage.find({sessionId:session.id}).sort({createdAt:1})})}catch(e){next(e)}});
app.post("/api/v1/ai/decisions/:id/regenerate",requireAuth,async(req:AuthRequest,res,next)=>{try{const session=await DecisionSession.findOne({_id:req.params.id,userId:req.user!.id});if(!session)return res.status(404).json({message:"Decision session not found"});const result=await buildDecision(String(session.caseId),"Regenerate with a fresh framing.",String(session._id));session.recommendation=result.recommendedOption;session.confidence=result.confidence;session.alternatives=result.alternatives;session.risks=result.risks;session.assumptions=result.assumptions;session.actionItems=result.actionItems;session.status="active";await session.save();res.json({session,result})}catch(e){next(e)}});
app.post("/api/v1/ai/decisions/:id/save",requireAuth,async(req:AuthRequest,res,next)=>{try{const session=await DecisionSession.findOneAndUpdate({_id:req.params.id,userId:req.user!.id},{status:"completed"},{new:true});if(!session)return res.status(404).json({message:"Decision session not found"});res.json({saved:true,session})}catch(e){next(e)}});
app.post("/api/v1/ai/decisions/:id/publish",requireAuth,async(req:AuthRequest,res,next)=>{try{const p=z.object({title:z.string().trim().min(3).max(120),summary:z.string().trim().min(20).max(1500)}).parse(req.body);const session=await DecisionSession.findOne({_id:req.params.id,userId:req.user!.id});if(!session)return res.status(404).json({message:"Decision session not found"});const item=await Case.findOne({_id:session.caseId,ownerId:req.user!.id});if(!item)return res.status(404).json({message:"Case not found"});item.publicInsight={title:p.title,summary:p.summary,publishedAt:new Date(),sourceSessionId:session._id} as any;if(item.visibility==="public"){item.status="Under review";item.moderationNote=undefined;item.moderatedAt=undefined;item.moderatedBy=undefined;}await item.save();res.json({publicInsight:item.publicInsight,status:item.status,visibility:item.visibility})}catch(e){next(e)}});
app.delete("/api/v1/cases/:id/public-insight",requireAuth,async(req:AuthRequest,res,next)=>{try{const item=await Case.findOne({_id:req.params.id,ownerId:req.user!.id});if(!item)return res.status(404).json({message:"Case not found"});item.publicInsight=undefined;if(item.visibility==="public"){item.status="Under review";item.moderationNote=undefined;item.moderatedAt=undefined;item.moderatedBy=undefined;}await item.save();res.json({removed:true,status:item.status})}catch(e){next(e)}});
app.get("/api/v1/analytics/user",requireAuth,async(req:AuthRequest,res,next)=>{try{const [ownedCases,docs,sessions]=await Promise.all([Case.find({ownerId:req.user!.id}).select("category status visibility createdAt").lean(),Document.countDocuments({ownerId:req.user!.id,processingStatus:"complete"}),DecisionSession.find({userId:req.user!.id,status:"completed"}).select("risks actionItems createdAt").lean()]);const countBy=(values:string[])=>Object.entries(values.reduce<Record<string,number>>((acc,value)=>{acc[value]=(acc[value]||0)+1;return acc},{})).map(([name,value])=>({name,value}));const monthlyMap=new Map<string,number>();ownedCases.forEach(item=>{const key=new Date(item.createdAt).toLocaleString("en",{month:"short"});monthlyMap.set(key,(monthlyMap.get(key)||0)+1)});res.json({caseCount:ownedCases.length,publicCases:ownedCases.filter(item=>item.visibility==="public").length,privateCases:ownedCases.filter(item=>item.visibility==="private").length,documentsProcessed:docs,decisionsCompleted:sessions.length,risksDetected:sessions.reduce((sum,item)=>sum+(item.risks?.length||0),0),activeActionItems:sessions.reduce((sum,item)=>sum+(item.actionItems?.length||0),0),casesByCategory:countBy(ownedCases.map(item=>item.category)),casesByStatus:countBy(ownedCases.map(item=>item.status)),monthlyActivity:Array.from(monthlyMap,([month,cases])=>({month,cases}))})}catch(e){next(e)}});
app.get("/api/v1/analytics/public",async(_req,res,next)=>{try{const [publicCases,decisionsCompleted,documentsProcessed]=await Promise.all([Case.countDocuments(approvedPublicFilter),DecisionSession.countDocuments({status:"completed"}),Document.countDocuments({processingStatus:"complete"})]);res.json({publicCases,decisionsCompleted,documentsProcessed})}catch(e){next(e)}});
app.get("/api/v1/analytics/admin",requireAuth,requireAdmin,async(_req,res,next)=>{try{const [users,cases,pendingCases,documents,failedDocuments]=await Promise.all([User.countDocuments(),Case.countDocuments(),Case.countDocuments({status:"Under review"}),Document.countDocuments(),Document.countDocuments({processingStatus:"failed"})]);res.json({users,cases,pendingCases,documents,processingSuccess:documents?Math.round(((documents-failedDocuments)/documents)*100):100})}catch(e){next(e)}});
app.get("/api/v1/admin/users",requireAuth,requireAdmin,async(_q,res,next)=>{try{res.json(await User.find().select("name email role status createdAt"))}catch(e){next(e)}});
app.patch("/api/v1/admin/users/:id/status",requireAuth,requireAdmin,async(req,res,next)=>{try{const p=z.object({status:z.enum(["active","suspended"])}).parse(req.body);const user=await User.findByIdAndUpdate(req.params.id,p,{new:true}).select("name email role status");if(!user)return res.status(404).json({message:"User not found"});res.json(user)}catch(e){next(e)}});
app.get("/api/v1/admin/cases",requireAuth,requireAdmin,async(req,res,next)=>{try{const status=typeof req.query.status==="string"?req.query.status:"";const filter=status&&["Draft","Under review","Approved","Rejected"].includes(status)?{status}:{};res.json(await Case.find(filter).populate("ownerId","name email").populate("moderatedBy","name").sort({status:1,updatedAt:-1}))}catch(e){next(e)}});
app.patch("/api/v1/admin/cases/:id/moderation",requireAuth,requireAdmin,async(req:AuthRequest,res,next)=>{try{const p=z.object({decision:z.enum(["approve","reject"]),note:z.string().trim().max(500).default("")}).parse(req.body);const item=await Case.findById(req.params.id);if(!item)return res.status(404).json({message:"Case not found"});if(item.visibility!=="public")return res.status(409).json({message:"Only cases submitted for public visibility can be moderated"});if(p.decision==="reject"&&p.note.length<5)return res.status(400).json({message:"Provide a clear rejection reason of at least 5 characters"});item.status=p.decision==="approve"?"Approved":"Rejected";item.moderationNote=p.note||"Approved for public discovery.";item.moderatedAt=new Date();item.moderatedBy=req.user!.id as any;await item.save();res.json(await item.populate([{path:"ownerId",select:"name email"},{path:"moderatedBy",select:"name"}]))}catch(e){next(e)}});
app.delete("/api/v1/admin/cases/:id",requireAuth,requireAdmin,async(req,res,next)=>{try{const item=await Case.findByIdAndDelete(req.params.id);if(!item)return res.status(404).json({message:"Case not found"});await deleteCaseDependents(item.id);res.status(204).end()}catch(e){next(e)}});
app.use((err:any,_q:any,res:any,_next:any)=>{if(err instanceof z.ZodError)return res.status(400).json({message:"Invalid request",issues:err.issues});if(err instanceof multer.MulterError)return res.status(400).json({message:err.message});console.error(err);if(typeof err?.statusCode==="number")return res.status(err.statusCode).json({message:err.message||"AI request failed",code:err.code});if(err instanceof Error&&err.message.includes("AI key storage"))return res.status(503).json({message:err.message});if(err instanceof Error&&(err.message.startsWith("Gemini ")||err.message.includes("no readable text")))return res.status(502).json({message:err.message});res.status(500).json({message:"Something went wrong"})});

export default app;
