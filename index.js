import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ========================================================= */
/* ENV CHECK                                                 */
/* ========================================================= */
const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
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
/* JOB WORKER ENDPOINT                                       */
/* ========================================================= */
app.post("/process", async (_, res) => {
  try {
    const { data: job, error } = await supabase.rpc("claim_next_ai_job");

    if (error) {
      console.error("❌ Failed to claim job", error);
      return res.sendStatus(500);
    }

    if (!job) {
      return res.sendStatus(204);
    }

    console.log(`▶ Processing job ${job.id}`);

    let result;

    switch (job.type) {
      case "generate-image":
        result = await generateImage(job.input, job.user_id, job.id);
        break;

      default:
        throw new Error("UNKNOWN_JOB_TYPE");
    }

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
    console.error("🔥 Job failed", err);

    return res.sendStatus(500);
  }
});

/* ========================================================= */
/* IMAGE GENERATION + STORAGE UPLOAD (ONLY CHANGE)           */
/* ========================================================= */
async function generateImage(input, userId, jobId) {
  const parts = [{ text: input.prompt }];

  if (input.referenceImages?.length) {
    for (const img of input.referenceImages) {
      const match = img.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) continue;

      parts.push({
        inlineData: {
          mimeType: match[1],
          data: match[2],
        },
      });
    }
  }

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

  let imageBase64;
  let mimeType = "image/png";

  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      mimeType = part.inlineData.mimeType;
      break;
    }
  }

  if (!imageBase64) {
    throw new Error("NO_IMAGE_RETURNED");
  }

  /* ---------- UPLOAD TO SUPABASE STORAGE ---------- */
  const buffer = Buffer.from(imageBase64, "base64");

  const filePath = `users/${userId}/renders/${jobId}-${crypto.randomUUID()}.png`;

  const { error: uploadError } = await supabase.storage
    .from("user_assets")
    .upload(filePath, buffer, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    throw uploadError;
  }

  const { data: publicUrl } = supabase.storage
    .from("user_assets")
    .getPublicUrl(filePath);

  return {
    imageUrl: publicUrl.publicUrl,
  };
}

/* ========================================================= */
/* SERVER START                                              */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Worker listening on port ${PORT}`);
});
