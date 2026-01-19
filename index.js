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
/* HARD TIMEOUT HELPER (FIX #1)                      */
/* ------------------------------------------------ */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("GENERATION_TIMEOUT")), ms)
    ),
  ]);
}

/* ------------------------------------------------ */
/* HEALTH CHECK                                     */
/* ------------------------------------------------ */
app.get("/", (_, res) => res.status(200).send("OK"));

/* ------------------------------------------------ */
/* IMAGE GENERATION                                 */
/* ------------------------------------------------ */
async function generateImage(input) {
  const parts = [];

  // 1️⃣ Reference image FIRST
  if (input.referenceImages?.length) {
    for (const img of input.referenceImages) {
      const m = img.match(/^data:(image\/\w+);base64,(.+)$/);
      if (m) {
        parts.push({
          inlineData: {
            mimeType: m[1],
            data: m[2],
          },
        });
      }
    }
  }

  // 2️⃣ Prompt AFTER image
  parts.push({
    text: `
You are given a REFERENCE IMAGE of an existing building.

STRICT RULES:
- Preserve geometry, massing, proportions
- Do NOT invent a new building
- Only adjust lighting, realism, materials

TASK:
${input.prompt}
`,
  });

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

  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      return {
        imageUrl: `data:image/png;base64,${part.inlineData.data}`,
      };
    }
  }

  throw new Error("NO_IMAGE_RETURNED");
}

/* ------------------------------------------------ */
/* JOB PROCESSOR                                    */
/* ------------------------------------------------ */
app.post("/process", async (req, res) => {
  const { job_id } = req.body;

  if (!job_id) return res.status(400).send("MISSING_JOB_ID");

  const { data: job } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("id", job_id)
    .single();

  if (!job) return res.sendStatus(404);

  await supabase
    .from("ai_jobs")
    .update({ status: "processing" })
    .eq("id", job_id);

  try {
    let result;

    if (job.type === "generate-image") {
      // 🔥 FIX #1 APPLIED HERE
      result = await withTimeout(
        generateImage(job.input),
        90_000 // 90 seconds max
      );
    } else {
      throw new Error(`UNKNOWN_JOB_TYPE: ${job.type}`);
    }

    await supabase
      .from("ai_jobs")
      .update({
        status: "completed",
        result,
        updated_at: new Date().toISOString(),
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
        updated_at: new Date().toISOString(),
      })
      .eq("id", job_id);

    return res.sendStatus(500);
  }
});

/* ------------------------------------------------ */
/* START                                            */
/* ------------------------------------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Gemini worker running on port ${PORT}`);
});
