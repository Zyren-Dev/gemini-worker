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
    /* --------------------------------------------- */
    /* 1️⃣ CLAIM JOB                                 */
    /* --------------------------------------------- */
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

    /* --------------------------------------------- */
    /* 2️⃣ EXECUTE JOB                               */
    /* --------------------------------------------- */
    const result = await generateImage(job);

    /* --------------------------------------------- */
    /* 3️⃣ COMPLETE JOB                              */
    /* --------------------------------------------- */
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
/* IMAGE GENERATION (GEMINI DOC-CORRECT)                     */
/* ========================================================= */
async function generateImage(job) {
  const input = job.input;
  const model = input.config.model;

  console.log("🧠 Model:", model);

  /* --------------------------------------------- */
  /* BUILD CONTENT PARTS                           */
  /* --------------------------------------------- */
  const parts = [
    { text: input.prompt }
  ];

  /* --------------------------------------------- */
  /* LOAD REFERENCE IMAGES (PRIVATE STORAGE)       */
  /* --------------------------------------------- */
  if (input.referenceImages?.length) {
    for (const ref of input.referenceImages) {
      const { data, error } = await supabase.storage
        .from(ref.bucket)
        .download(ref.path);

      if (error) throw error;

      const buffer = Buffer.from(await data.arrayBuffer());

      parts.push({
        inlineData: {
          mimeType: ref.mime,
          data: buffer.toString("base64"),
        },
      });
    }
  }

  /* --------------------------------------------- */
  /* BUILD GEMINI REQUEST (STRICT SPEC)            */
  /* --------------------------------------------- */
  const request = {
    model,
    contents: parts, // ⚠️ NOT chat format
  };

  // ✅ Gemini 3 Pro REQUIREMENTS
  if (model === "gemini-3-pro-image-preview") {
    request.config = {
      responseModalities: ["TEXT", "IMAGE"], // 🔴 REQUIRED
      imageConfig: {
        imageSize: input.config.imageSize,
        aspectRatio: input.config.aspectRatio,
      },
    };
  }

  // ✅ Flash models (more permissive)
  if (model.includes("flash")) {
    request.config = {
      imageConfig: {
        imageSize: input.config.imageSize,
        aspectRatio: input.config.aspectRatio,
      },
    };
  }

  /* --------------------------------------------- */
  /* CALL GEMINI                                   */
  /* --------------------------------------------- */
  const response = await ai.models.generateContent(request);

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

  /* --------------------------------------------- */
  /* STORE OUTPUT IMAGE                            */
  /* --------------------------------------------- */
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
    image_url: data.signedUrl,
  };
}

/* ========================================================= */
/* SERVER START                                              */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Worker listening on port ${PORT}`);
});
