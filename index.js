import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ---------------- ENV CHECK ---------------- */
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase env vars");
  process.exit(1);
}

/* ---------------- SUPABASE ---------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------------- HEALTH ---------------- */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/* ---------------- WORKER ---------------- */
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
        result = { imageUrl: "placeholder" };
        break;

      case "generate-video":
        result = { videoUrl: "placeholder" };
        break;

      case "analyze-material":
        result = { analysis: "placeholder" };
        break;

      default:
        throw new Error("UNKNOWN_JOB_TYPE");
    }

    await supabase
      .from("ai_jobs")
      .update({ status: "completed", result })
      .eq("id", job_id);

    return res.sendStatus(200);
  } catch (err) {
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

/* ---------------- START ---------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Worker running on port ${PORT}`);
});
