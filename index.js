import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ---------------- SUPABASE CLIENT ---------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (req, res) => {
  res.send("OK");
});

/* ---------------- JOB PROCESSOR ---------------- */
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

  // 🔒 idempotency guard
  if (job.status !== "pending") {
    return res.sendStatus(200);
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
    console.error("JOB FAILED", err);

    // 🔁 refund credits
    await supabase.rpc("refund_credits", {
      p_amount: job.cost,
      p_metadata: {
        job_id: job.id,
        reason: "generation_failed",
      },
    });

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

/* ---------------- SERVER START ---------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Worker running on port ${PORT}`);
});

/* ================================================= */
/* IMPLEMENT THESE FUNCTIONS BELOW                   */
/* ================================================= */

async function generateImage(input) {
  // Gemini image generation here
  return { imageUrl: "data:image/png;base64,..." };
}

async function generateVideo(input) {
  // Veo video generation here
  return { videoUrl: "data:video/mp4;base64,..." };
}

async function analyzeMaterial(input) {
  // Gemini analysis here
  return { material: "Concrete", confidence: 0.93 };
}
