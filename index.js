
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
  "API_KEY", // Standardized to Guideline requirement
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

// Initialization strictly follows SDK guidelines
const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY,
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
    const status = err?.status || err?.response?.status;
    console.error("🔥 Job error", err);

    if (status === 503 && job) {
      const { data: cancelledJob } = await supabase
        .from("ai_jobs")
        .update({
          status: "cancelled",
          error: "Model overloaded — credits refunded",
        })
        .eq("id", job.id)
        .eq("status", "processing")
        .select()
        .single();

      if (cancelledJob) {
        await supabase.rpc("refund_user_credits", {
          p_user_id: job.user_id,
          p_credits: job.credits_used,
        });
      }

      return res.sendStatus(200);
    }

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
/* IMAGE GENERATION (INPUT FROM STORAGE)                     */
/* ========================================================= */
async function generateImage(job) {
  const input = job.input;
  let model = input.config.model;

  // Normalizing Model Names for Pro vs Flash
  if (model.includes("nano") && model.includes("pro")) {
    model = "gemini-3-pro-image-preview";
  } else if (model.includes("flash") || model.includes("elite")) {
    model = "gemini-2.5-flash-image";
  }

  console.log("🧠 Targeting Neural Node:", model);

  const parts = [{ text: input.prompt }];

  /* LOAD REFERENCE IMAGES FROM STORAGE */
  if (input.referenceImages?.length) {
    for (const ref of input.referenceImages) {
      const { data, error } = await supabase.storage
        .from(ref.bucket)
        .download(ref.path);

      if (error) throw error;

      const buffer = Buffer.from(await data.arrayBuffer());
      const base64 = buffer.toString("base64");

      parts.push({
        inlineData: {
          mimeType: ref.mime || "image/png",
          data: base64,
        },
      });
    }
  }

  /* BUILD ENHANCED CONFIG FOR PRO */
  const isPro = model.includes("pro");
  const config = {
    imageConfig: {
      aspectRatio: input.config.aspectRatio || "1:1",
    }
  };

  // imageSize is EXCLUSIVE to Pro and must be 1K, 2K, or 4K
  if (isPro) {
    let size = String(input.config.imageSize || "1K").toUpperCase();
    if (!["1K", "2K", "4K"].includes(size)) {
      size = "1K"; // Fallback for stability
    }
    config.imageConfig.imageSize = size;
  }

  const response = await ai.models.generateContent({
    model,
    contents: { parts },
    config
  });

  let imageBase64;
  let mimeType = "image/png";

  // Pro results often contain multiple parts (text thoughts + image data)
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      mimeType = part.inlineData.mimeType;
      break;
    }
  }

  if (!imageBase64) throw new Error("NO_IMAGE_BUFFER: Synthesis failed to return pixel data.");

  /* STORE OUTPUT IMAGE */
  const buffer = Buffer.from(imageBase64, "base64");
  const ext = mimeType.split("/")[1] || "png";
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const path = `users/${job.user_id}/renders/${fileName}`;

  await supabase.storage
    .from("user_assets")
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: false,
    });

  const { data, error } = await supabase.storage
    .from("user_assets")
    .createSignedUrl(path, 60 * 5);

  if (error) throw error;

  return {
    imageUrl: data.signedUrl,
    storagePath: path
  };
}

/* ========================================================= */
/* SERVER START                                              */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Neural Worker listening on port ${PORT}`);
});
