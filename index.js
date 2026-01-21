import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" })); // safe margin

/* ========================================================= */
/* ENV CHECK                                                 */
/* ========================================================= */
const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "API_KEY",
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

/* ========================================================= */
/* HEALTH CHECK                                              */
/* ========================================================= */
app.get("/", (_, res) => res.send("OK"));

/* ========================================================= */
/* JOB WORKER ENDPOINT                                       */
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
      throw new Error("UNSUPPORTED_JOB_TYPE");
    }

    const result = await generateImage(job);

    await supabase
      .from("ai_jobs")
      .update({ status: "completed", result })
      .eq("id", job.id);

    console.log(`✅ Job ${job.id} completed`);
    return res.sendStatus(200);

  } catch (err) {
    const status = err?.status || err?.response?.status;
    console.error("🔥 Job error", err);

    if (status === 503 && job) {
      await supabase
        .from("ai_jobs")
        .update({
          status: "cancelled",
          error: "Model overloaded — credits refunded",
        })
        .eq("id", job.id);

      await supabase.rpc("refund_user_credits", {
        p_user_id: job.user_id,
        p_credits: job.credits_used,
      });

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
/* IMAGE GENERATION (SPEC-CORRECT)                           */
/* ========================================================= */
async function generateImage(job) {
  const input = job.input;
  let model = input.config.model;

  const isPro = model.includes("pro");
  model = isPro
    ? "gemini-3-pro-image-preview"
    : "gemini-2.5-flash-image";

  console.log(`🧠 Using model: ${model}`);

  // Fresh client per job (avoids poisoned sessions)
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const parts = [{ text: input.prompt }];

  /* ------------------------------------------------------- */
  /* LOAD REFERENCE IMAGES (PRO ONLY)                        */
  /* ------------------------------------------------------- */
  if (input.referenceImages?.length) {
    if (!isPro) {
      throw new Error("FLASH_DOES_NOT_SUPPORT_REFERENCE_IMAGES");
    }

    for (const ref of input.referenceImages) {
      const { data, error } = await supabase.storage
        .from(ref.bucket)
        .download(ref.path);

      if (error) throw error;

      const buffer = Buffer.from(await data.arrayBuffer());

      parts.push({
        inlineData: {
          mimeType: ref.mime || "image/png",
          data: buffer.toString("base64"),
        },
      });
    }
  }

  /* ------------------------------------------------------- */
  /* GEMINI REQUEST (DOC-VALID)                              */
  /* ------------------------------------------------------- */
  const config = {
    responseModalities: ["TEXT", "IMAGE"],
    imageConfig: {
      aspectRatio: input.config.aspectRatio || "1:1",
    },
  };

  if (isPro) {
    const size = String(input.config.imageSize || "1K").toUpperCase();
    if (["1K", "2K", "4K"].includes(size)) {
      config.imageConfig.imageSize = size;
    }
  }

  const response = await ai.models.generateContent({
    model,
    contents: parts, // ✅ THIS WAS THE CRITICAL FIX
    config,
  });

  let imageBase64;
  let mimeType = "image/png";

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      mimeType = part.inlineData.mimeType;
      break;
    }
  }

  if (!imageBase64) {
    throw new Error("NO_IMAGE_RETURNED");
  }

  /* ------------------------------------------------------- */
  /* STORE RESULT                                           */
  /* ------------------------------------------------------- */
  const buffer = Buffer.from(imageBase64, "base64");
  const ext = mimeType.split("/")[1] || "png";
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const path = `users/${job.user_id}/renders/${fileName}`;

  await supabase.storage.from("user_assets").upload(path, buffer, {
    contentType: mimeType,
    upsert: false,
  });

  const { data, error } = await supabase.storage
    .from("user_assets")
    .createSignedUrl(path, 60 * 15);

  if (error) throw error;

  return {
    imageUrl: data.signedUrl,
    storagePath: path,
  };
}

/* ========================================================= */
/* SERVER START                                              */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Worker listening on port ${PORT}`);
});
