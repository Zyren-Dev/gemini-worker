import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ================= ENV CHECK ================= */
["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY"].forEach(k => {
  if (!process.env[k]) {
    console.error(`❌ Missing env var ${k}`);
    process.exit(1);
  }
});

/* ================= CLIENTS ================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/* ================= HEALTH ================= */
app.get("/", (_, res) => res.send("OK"));

/* ================= WORKER ================= */
app.post("/process", async (_, res) => {
  try {
    const { data: job, error } = await supabase.rpc("claim_next_ai_job");

    if (error) {
      console.error("❌ claim_next_ai_job failed", error);
      return res.sendStatus(500);
    }

    if (!job) return res.sendStatus(204);

    console.log(`▶ Processing job ${job.id}`);

    let result;

    if (job.type === "generate-image") {
      result = await generateImage(job);
    } else {
      throw new Error("UNKNOWN_JOB_TYPE");
    }

    await supabase
      .from("ai_jobs")
      .update({ status: "completed", result })
      .eq("id", job.id);

    console.log(`✅ Job ${job.id} completed`);
    res.sendStatus(200);

  } catch (err) {
    console.error("🔥 Job failed", err);
    res.sendStatus(500);
  }
});

/* ================= IMAGE GENERATION ================= */
async function generateImage(job) {
  const { input, user_id } = job;
  const parts = [];

  /* ---- Load reference images from STORAGE ---- */
  for (const path of input.referenceImagePaths ?? []) {
    const { data, error } = await supabase
      .storage
      .from("user_assets")
      .download(path);

    if (error) throw error;

    const buffer = Buffer.from(await data.arrayBuffer());

    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: buffer.toString("base64"),
      },
    });
  }

  /* ---- Prompt LAST ---- */
  parts.push({ text: input.prompt });

  /* ---- Gemini call ---- */
  const res = await ai.models.generateContent({
    model: input.config.model,
    contents: { parts },
    config: {
      imageConfig: {
        imageSize: input.config.imageSize,
        aspectRatio: input.config.aspectRatio,
      },
    },
  });

  const imagePart = res.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imagePart) throw new Error("NO_IMAGE_RETURNED");

  const imageBase64 = imagePart.inlineData.data;

  /* ---- Upload result ---- */
  const filePath = `users/${user_id}/renders/${Date.now()}.png`;

  await supabase.storage
    .from("user_assets")
    .upload(
      filePath,
      Buffer.from(imageBase64, "base64"),
      { contentType: "image/png" }
    );

  const { data: url } = supabase
    .storage
    .from("user_assets")
    .getPublicUrl(filePath);

  return { imageUrl: url.publicUrl };
}

/* ================= START ================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Gemini worker running on port ${PORT}`);
});
