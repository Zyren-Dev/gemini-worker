import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ================================================= */
/* ENV CHECK                                         */
/* ================================================= */
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

/* ================================================= */
/* CLIENTS                                           */
/* ================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/* ================================================= */
/* HEALTH CHECK (REQUIRED BY CLOUD RUN)               */
/* ================================================= */
app.get("/", (_, res) => {
  res.status(200).send("OK");
});

/* ================================================= */
/* JOB PROCESSOR                                     */
/* ================================================= */
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

      case "generate-video":
        result = await generateVideo(job.input);
        break;

      case "analyze-material":
        result = await analyzeMaterial(job.input);
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
      .eq("id", job_id);

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Job failed:", err);

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

/* ================================================= */
/* GEMINI FUNCTIONS                                  */
/* ================================================= */

async function generateImage(input) {
  const parts = [];

  // ✅ Reference image (THIS FIXES BLACK OUTPUT)
  if (input.referenceImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: input.referenceImage.mimeType || "image/jpeg",
        data: input.referenceImage.base64,
      },
    });
  }

  // Prompt
  parts.push({ text: input.prompt });

  const res = await ai.models.generateContent({
    model: input.config.model || "gemini-2.5-flash-image",
    contents: { parts },
    config: {
      imageConfig: {
        imageSize: input.config.imageSize || "2K",
        aspectRatio: input.config.aspectRatio || "16:9",
      },
    },
  });

  let imageBase64 = null;

  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
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

async function generateVideo(input) {
  const op = await ai.models.generateVideos({
    model: input.config.model,
    prompt: input.prompt,
    config: {
      resolution: input.config.resolution,
      aspectRatio: input.config.aspectRatio,
      numberOfVideos: 1,
    },
  });

  let finalOp = op;

  while (!finalOp.done) {
    await new Promise((r) => setTimeout(r, 5000));
    finalOp = await ai.operations.getVideosOperation({
      operation: finalOp,
    });
  }

  const uri = finalOp.response?.generatedVideos?.[0]?.video?.uri;
  if (!uri) throw new Error("NO_VIDEO_RETURNED");

  const videoRes = await fetch(`${uri}&key=${process.env.GEMINI_API_KEY}`);
  const buffer = await videoRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  return {
    videoUrl: `data:video/mp4;base64,${base64}`,
  };
}

async function analyzeMaterial(input) {
  const res = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: input.image.mimeType,
            data: input.image.base64,
          },
        },
        { text: "Return strictly valid JSON." },
      ],
    },
  });

  return {
    analysis: res.text,
  };
}

/* ================================================= */
/* START SERVER                                      */
/* ================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Gemini worker running on port ${PORT}`);
});
