import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* ------------------------------------------------ */
/* ENV CHECK                                        */
/* ------------------------------------------------ */
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

/* ------------------------------------------------ */
/* CLIENTS                                          */
/* ------------------------------------------------ */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/* ------------------------------------------------ */
/* HEALTH CHECK                                     */
/* ------------------------------------------------ */
app.get("/", (_, res) => {
  res.status(200).send("OK");
});

/* ------------------------------------------------ */
/* JOB PROCESSOR                                    */
/* ------------------------------------------------ */
app.post("/process", async (req, res) => {
  const { job_id } = req.body;

  if (!job_id) {
    return res.status(400).send("MISSING_JOB_ID");
  }

  const { data: job, error } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("id", job_id)
    .single();

  if (error || !job) {
    return res.sendStatus(404);
  }

  await supabase
    .from("ai_jobs")
    .update({ status: "processing" })
    .eq("id", job_id);

  try {
    let result;

    switch (job.type) {
      case "generate-image":
        result = await generateImage(job.input);
        break;

      default:
        throw new Error(`UNKNOWN_JOB_TYPE: ${job.type}`);
    }

    await supabase
      .from("ai_jobs")
      .update({
        status: "completed",
        result,
      })
      .eq("id", job_id);

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ JOB FAILED", err);

    await supabase
      .from("ai_jobs")
      .update({
        status: "failed",
        error: String(err),
      })
      .eq("id", job_id);

    return res.sendStatus(500);
  }
});

/* ------------------------------------------------ */
/* IMAGE GENERATION (CRITICAL FIX APPLIED)           */
/* ------------------------------------------------ */
async function generateImage(input) {
  const parts = [];

  /* 1️⃣ REFERENCE IMAGE FIRST (MANDATORY) */
  if (input.referenceImages?.length) {
    for (const img of input.referenceImages) {
      const match = img.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) continue;

      parts.push({
        inlineData: {
          mimeType: match[1],
          data: match[2], // base64 ONLY
        },
      });
    }
  }

  /* 2️⃣ STRONGLY BOUND PROMPT */
  parts.push({
    text: `
You are given a REFERENCE IMAGE of an existing building.

STRICT RULES (DO NOT VIOLATE):
- Preserve EXACT geometry, massing, proportions, and façade layout
- Do NOT invent a new building
- Do NOT change structure
- ONLY adjust lighting, atmosphere, materials, and realism

TASK:
${input.prompt}
`,
  });

  const res = await ai.models.generateContent({
    model: input.config.model, // e.g. gemini-3-pro-image-preview
    contents: { parts },
    config: {
      imageConfig: {
        imageSize: input.config.imageSize,
        aspectRatio: input.config.aspectRatio,
      },
    },
  });

  let imageBase64;

  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      break;
    }
  }

  if (!imageBase64) {
    throw new Error("NO_IMAGE_RETURNED");
  }

  return {
    imageUrl: `data:image/png;base64,${imageBase64}`,
  };
}

/* ------------------------------------------------ */
/* SERVER START                                     */
/* ------------------------------------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Gemini worker running on port ${PORT}`);
});
