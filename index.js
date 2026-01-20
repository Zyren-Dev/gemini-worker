import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ========================================================= */
/* ENV CHECK                                                 */
/* ========================================================= */
["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY"].forEach(
  (key) => {
    if (!process.env[key]) {
      console.error(`❌ Missing env var: ${key}`);
      process.exit(1);
    }
  }
);

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
/* JOB WORKER                                                */
/* ========================================================= */
app.post("/process", async (_, res) => {
  let job;

  try {
    /* 1️⃣ CLAIM ONE JOB */
    const { data, error } = await supabase.rpc("claim_next_ai_job");

    if (error) throw error;
    if (!data) return res.sendStatus(204);

    job = data;
    console.log(`▶ Processing job ${job.id}`);

    /* 2️⃣ EXECUTE */
    let result;

    if (job.type === "generate-image") {
      result = await generateImage(job);
    } else {
      throw new Error(`UNKNOWN_JOB_TYPE: ${job.type}`);
    }

    /* 3️⃣ COMPLETE */
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

    if (job?.id) {
      await supabase
        .from("ai_jobs")
        .update({
          status: "failed",
          error: err?.message ?? JSON.stringify(err),
        })
        .eq("id", job.id);
    }

    return res.sendStatus(500);
  }
});

/* ========================================================= */
/* IMAGE GENERATION                                          */
/* ========================================================= */
async function generateImage(job) {
  const { input, user_id } = job;
  const parts = [];

  /* ---------- LOAD REFERENCE IMAGES ---------- */
  if (input.referenceImagePaths?.length) {
    for (const path of input.referenceImagePaths) {
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

  const imagePart =
    res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);

  if (!imagePart) {
    throw new Error("NO_IMAGE_RETURNED");
  }

  /* ---------- UPLOAD RESULT ---------- */
  const imageBase64 = imagePart.inlineData.data;
  const filePath = `users/${user_id}/renders/${Date.now()}.png`;

  const { error: uploadError } = await supabase.storage
    .from("user_assets")
    .upload(filePath, Buffer.from(imageBase64, "base64"), {
      contentType: "image/png",
      upsert: false,
    });

  if (uploadError) throw uploadError;

  const { data: publicUrl } = supabase.storage
    .from("user_assets")
    .getPublicUrl(filePath);

  return {
    imageUrl: publicUrl.publicUrl,
  };
}

/* ========================================================= */
/* START SERVER                                              */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Gemini worker running on port ${PORT}`);
});
