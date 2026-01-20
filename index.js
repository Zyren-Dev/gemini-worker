import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "5mb" }));

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
    /* 1️⃣ CLAIM JOB */
    const { data: job, error } = await supabase.rpc("claim_next_ai_job");

    if (error) {
      console.error("❌ Failed to claim job", error);
      return res.sendStatus(500);
    }

    if (!job) {
      return res.sendStatus(204); // No jobs
    }

    console.log(`▶ Processing job ${job.id}`);

    /* 2️⃣ EXECUTE */
    let renderPath: string | null = null;

    if (job.type === "generate-image") {
      renderPath = await generateImage(job);
    } else {
      throw new Error(`UNKNOWN_JOB_TYPE: ${job.type}`);
    }

    /* 3️⃣ MARK COMPLETE */
    await supabase
      .from("ai_jobs")
      .update({
        status: "completed",
        result: { render_path: renderPath },
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
/* IMAGE GENERATION (STORAGE → GEMINI → STORAGE)             */
/* ========================================================= */
async function generateImage(job) {
  const parts: any[] = [];

  /* --------------------------------------------- */
  /* 1️⃣ LOAD REFERENCE IMAGES FROM STORAGE         */
  /* --------------------------------------------- */
  if (job.input.referenceImagePaths?.length) {
    for (const path of job.input.referenceImagePaths) {
      const { data, error } = await supabase.storage
        .from("user_assets")
        .download(path);

      if (error || !data) {
        throw new Error(`FAILED_TO_DOWNLOAD_REF: ${path}`);
      }

      const buffer = Buffer.from(await data.arrayBuffer());

      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: buffer.toString("base64"),
        },
      });
    }
  }

  /* --------------------------------------------- */
  /* 2️⃣ ADD PROMPT                                */
  /* --------------------------------------------- */
  parts.push({ text: job.input.prompt });

  /* --------------------------------------------- */
  /* 3️⃣ CALL GEMINI                               */
  /* --------------------------------------------- */
  const res = await ai.models.generateContent({
    model: job.input.config.model,
    contents: { parts },
    config: {
      imageConfig: {
        imageSize: job.input.config.imageSize,
        aspectRatio: job.input.config.aspectRatio,
      },
    },
  });

  let imageBase64: string | null = null;
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

  /* --------------------------------------------- */
  /* 4️⃣ UPLOAD FINAL RENDER TO STORAGE             */
  /* --------------------------------------------- */
  const renderPath = `users/${job.user_id}/renders/${job.id}.png`;

  const { error: uploadErr } = await supabase.storage
    .from("user_assets")
    .upload(
      renderPath,
      Buffer.from(imageBase64, "base64"),
      {
        contentType: mimeType,
        upsert: true,
      }
    );

  if (uploadErr) throw uploadErr;

  return renderPath;
}

/* ========================================================= */
/* SERVER START                                              */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Gemini worker running on port ${PORT}`);
});
