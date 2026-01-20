import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

/* ================= SAFETY ================= */
process.on("uncaughtException", err => {
  console.error("UNCAUGHT_EXCEPTION", err);
});

process.on("unhandledRejection", err => {
  console.error("UNHANDLED_REJECTION", err);
});

/* ================= APP ================= */
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ================= ENV CHECK ================= */
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var ${key}`);
    process.exit(1);
  }
}

/* ================= CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

/* ================= HEALTH ================= */
app.get("/", (_, res) => {
  res.status(200).send("OK");
});

/* ================= PROCESS JOB ================= */
app.post("/process", async (req, res) => {
  let job: any = null;

  try {
    const { job_id } = req.body ?? {};
    if (!job_id) {
      return res.status(400).send("MISSING_JOB_ID");
    }

    /* ---------- FETCH JOB ---------- */
    const { data, error } = await supabase
      .from("ai_jobs")
      .select("*")
      .eq("id", job_id)
      .eq("status", "pending")
      .single();

    if (error || !data) {
      console.warn("ℹ️ Job not found or already handled:", job_id);
      return res.sendStatus(204);
    }

    job = data;

    /* ---------- LOCK JOB ---------- */
    await supabase
      .from("ai_jobs")
      .update({ status: "processing" })
      .eq("id", job.id);

    console.log("▶ Processing job:", job.id);

    if (job.type !== "generate-image") {
      throw new Error(`UNSUPPORTED_JOB_TYPE:${job.type}`);
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
    console.error("🔥 JOB FAILED", err);

    if (job?.id) {
      const safeError =
        err instanceof Error
          ? err.message
          : typeof err === "string"
          ? err
          : "UNKNOWN_ERROR";

      await supabase
        .from("ai_jobs")
        .update({
          status: "failed",
          error: safeError,
        })
        .eq("id", job.id);
    }

    return res.sendStatus(500);
  }
});

/* ================= IMAGE GENERATION ================= */
async function generateImage(job: any) {
  const { input, user_id } = job;

  if (!input?.prompt) {
    throw new Error("INVALID_INPUT_PROMPT");
  }

  const parts: any[] = [];

  /* ---------- LOAD REFERENCE IMAGES ---------- */
  for (const path of input.referenceImagePaths ?? []) {
    const { data, error } = await supabase
      .storage
      .from("user_assets")
      .download(path);

    if (error || !data) {
      throw new Error(`REFERENCE_DOWNLOAD_FAILED:${path}`);
    }

    const buffer = Buffer.from(await data.arrayBuffer());

    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: buffer.toString("base64"),
      },
    });
  }

  /* ---------- PROMPT ---------- */
  parts.push({ text: input.prompt });

  /* ---------- GEMINI IMAGE GENERATION ---------- */
  const response = await ai.models.generateContent({
    model: input.config.model,
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
    },
  });

  const imagePart =
    response.candidates?.[0]?.content?.parts?.find(
      (p: any) => p.inlineData?.data
    );

  if (!imagePart) {
    throw new Error("NO_IMAGE_RETURNED");
  }

  const imageBase64 = imagePart.inlineData.data;

  /* ---------- STORE IMAGE ---------- */
  const filePath = `users/${user_id}/renders/${Date.now()}.png`;

  const upload = await supabase.storage
    .from("user_assets")
    .upload(
      filePath,
      Buffer.from(imageBase64, "base64"),
      { contentType: "image/png" }
    );

  if (upload.error) {
    throw new Error("IMAGE_UPLOAD_FAILED");
  }

  const { data: url } = supabase
    .storage
    .from("user_assets")
    .getPublicUrl(filePath);

  return {
    imageUrl: url.publicUrl,
  };
}

/* ================= START SERVER ================= */
const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Gemini worker listening on port ${PORT}`);
});
