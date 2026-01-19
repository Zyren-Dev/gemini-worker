import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();

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
app.get("/", (_, res) => res.status(200).send("OK"));

/* ------------------------------------------------ */
/* IMAGE GENERATION                                 */
/* ------------------------------------------------ */
async function generateImage(input) {
  const parts = [];

  // 🔑 reference image FIRST
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
/* JOB LOOP (THE FIX)                               */
/* ------------------------------------------------ */
async function jobLoop() {
  while (true) {
    const { data: job } = await supabase.rpc("claim_next_ai_job");

    if (!job || job.length === 0) {
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    const { id, type, input } = job[0];

    try {
      let result;

      if (type === "generate-image") {
        result = await generateImage(input);
      } else {
        throw new Error(`UNKNOWN_JOB_TYPE: ${type}`);
      }

      await supabase
        .from("ai_jobs")
        .update({
          status: "completed",
          result,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    } catch (err) {
      console.error("❌ JOB FAILED", err);

      await supabase
        .from("ai_jobs")
        .update({
          status: "failed",
          error: String(err),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    }
  }
}

/* ------------------------------------------------ */
/* START                                            */
/* ------------------------------------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Gemini worker running on port ${PORT}`);
  jobLoop(); // 🔥 START WORKER LOOP
});
