
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ========================================================= */
/* CLIENT INITIALIZATION                                     */
/* ========================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY,
});

/* ========================================================= */
/* HEALTH CHECK & STARTUP                                    */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Neural Worker active on port ${PORT}`);
  const REQUIRED_ENVS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "API_KEY", "WORKER_SECRET"];
  REQUIRED_ENVS.forEach(key => {
    if (!process.env[key]) console.warn(`⚠️ Warning: Missing [${key}].`);
  });
});

app.get("/", (_, res) => res.send("OK"));

/* ========================================================= */
/* UTILITIES                                                 */
/* ========================================================= */

/**
 * Enhanced Exponential Backoff Utility
 * Retries the AI call if the model is overloaded (503) or rate limited (429).
 * Pro models get a longer window and more attempts because they are higher demand.
 */
async function callGeminiWithRetry(fn, isPro = false) {
  const maxRetries = isPro ? 6 : 3; 
  const baseDelay = isPro ? 4000 : 2000;
  
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err?.status || err?.response?.status;
      
      // Retry on transient errors (503: Overloaded, 429: Rate Limit)
      if (status === 503 || status === 429) {
        // Exponential backoff with jitter to prevent collision
        const jitter = Math.random() * 1000;
        const delay = (Math.pow(2, i) * baseDelay) + jitter;
        
        console.warn(`⏳ [Attempt ${i + 1}/${maxRetries}] Neural Node (${isPro ? 'Pro' : 'Flash'}) busy: ${status}. Retrying in ${Math.round(delay)}ms...`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      // Critical error (400, 401, etc.) - do not retry
      throw err;
    }
  }
  throw lastError;
}

/* ========================================================= */
/* JOB WORKER ENDPOINT                                       */
/* ========================================================= */
app.post("/process", async (req, res) => {
  if (!process.env.WORKER_SECRET || req.headers["x-worker-secret"] !== process.env.WORKER_SECRET) {
    return res.status(401).send("UNAUTHORIZED");
  }

  let job;

  try {
    const { data, error } = await supabase.rpc("claim_next_ai_job");
    if (error || !data) return res.sendStatus(error ? 500 : 204);

    job = data;
    console.log(`▶ Processing job ${job.id} for user ${job.user_id}`);

    if (job.type !== "generate-image") throw new Error("UNKNOWN_JOB_TYPE");

    const result = await generateImage(job);

    await supabase
      .from("ai_jobs")
      .update({ status: "completed", result })
      .eq("id", job.id);

    console.log(`✅ Job ${job.id} completed successfully`);
    return res.sendStatus(200);

  } catch (err) {
    const status = err?.status || err?.response?.status;
    console.error("🔥 Job execution failed:", err.message || err);

    // If retries failed and it's still 503, refund credits
    if (status === 503 && job) {
      console.log(`♻️ Refunding user ${job.user_id} due to persistent 503 error.`);
      await supabase
        .from("ai_jobs")
        .update({ status: "cancelled", error: "Engine saturated - credits restored automatically." })
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
        .update({ status: "failed", error: String(err.message || err) })
        .eq("id", job.id);
    }

    return res.status(500).send(err.message || "INTERNAL_ERROR");
  }
});

/* ========================================================= */
/* IMAGE GENERATION LOGIC                                    */
/* ========================================================= */
async function generateImage(job) {
  const input = job.input;
  let model = input.config.model;

  // Normalize model string
  const isPro = model.includes("pro");
  if (isPro) {
    model = "gemini-3-pro-image-preview";
  } else {
    model = "gemini-2.5-flash-image";
  }

  console.log("🧠 Invoking model:", model);

  const parts = [{ text: input.prompt }];

  /* Reference Assets Ingestion */
  if (input.referenceImages?.length) {
    for (const ref of input.referenceImages) {
      const { data, error } = await supabase.storage.from(ref.bucket).download(ref.path);
      if (error) throw error;
      const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
      parts.push({ inlineData: { mimeType: ref.mime || "image/png", data: base64 } });
    }
  }

  /* Configuration Matrix */
  const config = {
    imageConfig: {
      aspectRatio: input.config.aspectRatio || "1:1",
    }
  };

  if (isPro) {
    let size = String(input.config.imageSize || "1K").toUpperCase();
    if (!["1K", "2K", "4K"].includes(size)) size = "1K";
    config.imageConfig.imageSize = size;
  }

  /* Execution with Patient Retry logic for Pro */
  const response = await callGeminiWithRetry(() => 
    ai.models.generateContent({
      model,
      contents: { parts },
      config
    }),
    isPro
  );

  let imageBase64;
  let mimeType = "image/png";

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      mimeType = part.inlineData.mimeType;
      break;
    }
  }

  if (!imageBase64) throw new Error("EMPTY_DATA_BUFFER: Synthesis failed to materialize pixels.");

  /* Storage Persistence */
  const buffer = Buffer.from(imageBase64, "base64");
  const fileName = `${crypto.randomUUID()}.${mimeType.split("/")[1] || "png"}`;
  const path = `users/${job.user_id}/renders/${fileName}`;

  await supabase.storage.from("user_assets").upload(path, buffer, { contentType: mimeType });

  const { data, error } = await supabase.storage.from("user_assets").createSignedUrl(path, 60 * 15);
  if (error) throw error;

  return { imageUrl: data.signedUrl, storagePath: path };
}
