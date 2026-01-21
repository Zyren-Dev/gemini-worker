import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "5mb" }));

/* ========================================================= */
/* ENV CHECK                                                 */
/* ========================================================= */
const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
  "WORKER_SECRET",
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

/* ========================================================= */
/* CLIENTS                                                   */
/* ========================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/* ========================================================= */
/* HEALTH CHECK                                              */
/* ========================================================= */
app.get("/", (_, res) => res.send("OK"));

/* ========================================================= */
/* JOB WORKER ENDPOINT (PROTECTED)                           */
/* ========================================================= */
app.post("/process", async (req, res) => {
  if (req.headers["x-worker-secret"] !== process.env.WORKER_SECRET) {
    return res.sendStatus(401);
  }

  let job;

  try {
    const { data, error } = await supabase.rpc("claim_next_ai_job");

    if (error) {
      console.error("❌ Failed to claim job", error);
      return res.sendStatus(500);
    }

    if (!data) return res.sendStatus(204);

    job = data;
    console.log(`▶ Processing job ${job.id}`);

    if (job.type !== "generate-image") {
      throw new Error("UNKNOWN_JOB_TYPE");
    }

    const result = await generateImage(job);

    await supabase
      .from("ai_jobs")
      .update({
        status: "completed",
        result,
      })
      .eq("id", job.id);

    console.log(`✅ Job ${job.id} completed`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("🔥 Job error", err);

    if (job) {
      await supabase
        .from("ai_jobs")
        .update({
          status: "failed",
          error: String(err),
        })
        .eq("id", job.id);
    }

    return res.sendStatus(500);
  }
});

/* ========================================================= */
/* IMAGE GENERATION (DOC-CORRECT)                            */
/* ========================================================= */
async function generateImage(job) {
  const input = job.input;
  const model = input.config.model;

  console.log("🧠 Model:", model);

  const parts = [{ text: input.prompt }];

  /* --------------------------------------------- */
  /* LOAD REFERENCE IMAGES FROM STORAGE             */
  /* --------------------------------------------- */
  if (input.referenceImages?.length
