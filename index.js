import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

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
    /* 1️⃣ CLAIM ONE JOB */
    const { data: job, error } = await supabase.rpc("claim_next_ai_job");

    if (error) {
      console.error("❌ Failed to claim job", error);
      return res.sendStatus(500);
    }

    if (!job) {
      return res.sendStatus(204); // no jobs
    }

    console.log(`▶ Processing job ${job.id}`);

    /* 2️⃣ EXECUTE JOB */
    let result;

    switch (job.type) {
      case "generate-image":
        result = await generateImage(job);
        break;

      default:
        throw new Error(`UNKNOWN_JOB_TYPE: ${job.type}`);
    }

    /* 3️⃣ MARK COMPLETE */
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
/* IMAGE GENERATION (URL → BASE64 → GEMINI → STORAGE)        */
/* ========================================================= */
async function generateImage(job) {
  const { input, user_id } = job;
  const parts = [];

  /* ---------- REFERENCE IMAGES ---------- */
  if (input.referenceImages?.length) {
    for (const ref of input.referenceImages) {

      // Base64 (legacy)
      if (ref.startsWith("data:image")) {
        const match = ref.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) continue;

        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }

      // Supabase URL (current)
      else if (ref.startsWith("http")) {
        const response = await fetch(ref);
        if (!response.ok) {
          throw new Error("FAILED_TO_FETCH_REFERENCE_IMAGE");
        }

        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");

        parts.push({
          inlineData: {
            mimeType: response.headers.get("content-type") || "image/png",
            data: base64,
          },
        });
      }
    }
  }

  /* ---------- PROMPT MUST BE LAST ---------- */
  parts.push({ text: input.prompt });

  /* ---------- GEMINI CALL ---------- */
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

  const imagePart = res.candidates?.[0]?.content?.parts?.find(
    p => p.inlineData
  );

  if (!imagePart) {
    throw new Error("NO_IMAGE_RETURNED");
  }

  /* ---------- UPLOAD RESULT TO STORAGE ---------- */
  const imageBase64 = imagePart.inlineData.data;
  const mimeType = imagePart.inlineData.mimeType || "image/png";
  const ext = mimeType.split("/")[1];

  const filePath = `users/${user_id}/renders/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase
    .storage
    .from("user_assets")
    .upload(
      filePath,
      Buffer.from(imageBase64, "base64"),
      {
        contentType: mimeType,
        upsert: false,
      }
    );

  if (uploadError) {
    throw uploadError;
  }

  const { data: publicUrl } = supabase
    .storage
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
  console.log(`🚀 Gemini worker running on port ${PORT}`);
});
