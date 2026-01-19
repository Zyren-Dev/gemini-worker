import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ================= ENV CHECK ================= */
if (
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY ||
  !process.env.GEMINI_API_KEY
) {
  console.error("❌ Missing environment variables");
  process.exit(1);
}

/* ================= SUPABASE ================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================= GEMINI ================= */
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/* ================= HEALTH ================= */
app.get("/", (_, res) => {
  res.status(200).send("OK");
});

/* ================= WORKER ================= */
app.post("/process", async (req, res) => {
  const { job_id } = req.body;
  if (!job_id) return res.status(400).send("MISSING_JOB_ID");

  const { data: job, error } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("id", job_id)
    .single();

  if (error || !job) return res.sendStatus(404);

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
    console.error(err);

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

/* ================= START ================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Worker running on port ${PORT}`);
});

/* ================================================= */
/* =============== GEMINI IMAGE ==================== */
/* ================================================= */

async function generateImage(input) {
  const parts = [{ text: input.prompt }];

  // ✅ reference image (THIS is what fixes your issue)
  if (input.referenceImage) {
    const match = input.referenceImage.match(
      /^data:(image\/\w+);base64,(.+)$/
    );

    if (!match) throw new Error("INVALID_IMAGE_FORMAT");

    parts.push({
      inlineData: {
        mimeType: match[1],
        data: match[2], // base64 only
      },
    });
  }

  const res = await ai.models.generateContent({
    model: input.config.model, // gemini-2.5-flash-image
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
